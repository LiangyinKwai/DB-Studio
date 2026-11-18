use super::*;

#[tokio::test]
async fn redis_console_release_cancels_an_unfinished_connection_without_reinserting_it() {
    let state = Arc::new(BackendState::default());
    let key = redis_console_key("redis-test", "opening");
    let (started, ready) = tokio::sync::oneshot::channel();
    let task_state = state.clone();
    let task_key = key.clone();
    let task = tokio::spawn(async move {
        redis_console_client_with(&task_state, &task_key, || async {
            let _ = started.send(());
            std::future::pending::<Result<redis::aio::MultiplexedConnection, String>>().await
        }).await
    });
    ready.await.unwrap();
    assert!(release_redis_console_session(&state, &key).unwrap());
    assert!(!release_redis_console_session(&state, &key).unwrap());
    assert!(timeout(Duration::from_secs(1), task).await.unwrap().unwrap().is_err());
    assert!(state.redis_console_connections.lock().unwrap().is_empty());
    assert!(state.redis_console_sessions.lock().unwrap().is_empty());
}

#[tokio::test]
async fn redis_console_disconnect_cancels_only_the_matching_instances_sessions() {
    let state = BackendState::default();
    let target = Arc::new(RedisConsoleSession::default());
    let other = Arc::new(RedisConsoleSession::default());
    state.redis_console_sessions.lock().unwrap().insert(redis_console_key("test", "opening"), target.clone());
    state.redis_console_sessions.lock().unwrap().insert(redis_console_key("test-other", "opening"), other.clone());
    disconnect_clients(&state, "test").await.unwrap();
    assert!(*target.closed.borrow());
    assert!(!*other.closed.borrow());
    assert_eq!(state.redis_console_sessions.lock().unwrap().len(), 1);
    assert!(run_redis_console_operation(&target, async { Ok(()) }).await.is_err(), "an already-closed session must not start a command");
}

struct DisposableRedis {
    process: std::process::Child,
    directory: std::path::PathBuf,
    port: u16,
}

impl DisposableRedis {
    fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let directory = std::env::temp_dir().join(format!("db-studio-console-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let log = std::fs::File::create(directory.join("server.log")).unwrap();
        drop(listener);
        let process = std::process::Command::new("redis-server")
            .env("LC_ALL", "C")
            .args(["--bind", "127.0.0.1", "--port", &port.to_string(), "--save", "", "--appendonly", "no", "--protected-mode", "yes"])
            .arg("--dir").arg(&directory)
            .stderr(log.try_clone().unwrap()).stdout(log)
            .spawn().expect("install local redis-server to run the isolated lifecycle contract");
        Self { process, directory, port }
    }
}

impl Drop for DisposableRedis {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

async fn local_client(port: u16) -> Result<redis::aio::MultiplexedConnection, String> {
    redis_adapter::connect("127.0.0.1", port, 0, "", "", false, None).await
}

async fn wait_client_count(client: &mut redis::aio::MultiplexedConnection, expected: usize) {
    timeout(Duration::from_secs(2), async {
        loop {
            let clients: String = redis::cmd("CLIENT").arg("LIST").query_async(client).await.unwrap();
            if clients.lines().count() == expected { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("released consoles must close the actual Redis sockets");
}

#[tokio::test]
#[ignore = "requires local redis-server; starts and removes its own isolated loopback server"]
async fn redis_console_release_runtime_contract() {
    let server = DisposableRedis::start();
    let mut verifier = timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(client) = local_client(server.port).await { break client; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.unwrap_or_else(|error| panic!("local Redis did not start: {error}; {}", std::fs::read_to_string(server.directory.join("server.log")).unwrap_or_default()));
    let state = Arc::new(BackendState::default());

    // A socket established by an in-progress connect must also be dropped,
    // even though it has not yet entered the connection cache.
    let key = redis_console_key("test", "opening-socket");
    let task_state = state.clone(); let task_key = key.clone(); let port = server.port;
    let (started, ready) = tokio::sync::oneshot::channel();
    let opening = tokio::spawn(async move {
        redis_console_client_with(&task_state, &task_key, || async {
            let client = local_client(port).await?;
            let _ = started.send(());
            std::future::pending::<()>().await;
            Ok(client)
        }).await
    });
    ready.await.unwrap();
    wait_client_count(&mut verifier, 2).await;
    release_redis_console_session(&state, &key).unwrap();
    assert!(timeout(Duration::from_secs(1), opening).await.unwrap().unwrap().is_err());
    wait_client_count(&mut verifier, 1).await;

    // Repeatedly opening/closing consoles must not increase server clients.
    for index in 0..25 {
        let key = redis_console_key("test", &format!("normal-{index}"));
        let (client, _) = redis_console_client_with(&state, &key, || local_client(server.port)).await.unwrap();
        assert_eq!(redis_adapter::ping(&mut *client.lock().await).await.unwrap(), "PONG");
        drop(client);
        assert!(release_redis_console_session(&state, &key).unwrap());
        assert!(!release_redis_console_session(&state, &key).unwrap());
        wait_client_count(&mut verifier, 1).await;
    }

    // Concurrent first commands share a single canonical socket.
    let key = redis_console_key("test", "simultaneous");
    let connects = std::sync::atomic::AtomicUsize::new(0);
    let connect = || async {
        connects.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(20)).await;
        local_client(server.port).await
    };
    let (first, second) = tokio::join!(redis_console_client_with(&state, &key, connect), redis_console_client_with(&state, &key, connect));
    let (first, _) = first.unwrap(); let (second, _) = second.unwrap();
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(connects.load(Ordering::SeqCst), 1);
    drop(first); drop(second);
    release_redis_console_session(&state, &key).unwrap();
    wait_client_count(&mut verifier, 1).await;

    // Closing drops queued MULTI writes and WATCH state with the socket.
    let key = redis_console_key("test", "transaction");
    let (client, _) = redis_console_client_with(&state, &key, || local_client(server.port)).await.unwrap();
    for command in ["WATCH lifecycle:queued", "MULTI", "SET lifecycle:queued must-not-commit"] {
        redis_adapter::execute_console_command(&mut *client.lock().await, command).await.unwrap();
    }
    drop(client);
    release_redis_console_session(&state, &key).unwrap();
    wait_client_count(&mut verifier, 1).await;
    let value: Option<String> = redis::cmd("GET").arg("lifecycle:queued").query_async(&mut verifier).await.unwrap();
    assert_eq!(value, None);
    let new_key = redis_console_key("test", "new-transaction");
    let (client, _) = redis_console_client_with(&state, &new_key, || local_client(server.port)).await.unwrap();
    assert!(redis_adapter::execute_console_command(&mut *client.lock().await, "EXEC").await.unwrap_err().contains("without MULTI"));
    drop(client);
    release_redis_console_session(&state, &new_key).unwrap();

    // BLPOP 0 is a genuine indefinitely-blocked server request. Merely dropping
    // its response future would leave the driver/socket alive without cleanup.
    for disconnect in [false, true] {
        let key = redis_console_key("test", if disconnect { "blocked-disconnect" } else { "blocked-close" });
        let task_state = state.clone(); let task_key = key.clone(); let port = server.port;
        let blocked = tokio::spawn(async move {
            let (client, session) = redis_console_client_with(&task_state, &task_key, || local_client(port)).await?;
            run_redis_console_operation(&session, async {
                redis_adapter::execute_console_command(&mut *client.lock().await, "BLPOP lifecycle:empty 0").await
            }).await
        });
        timeout(Duration::from_secs(2), async {
            loop {
                let clients: String = redis::cmd("CLIENT").arg("LIST").query_async(&mut verifier).await.unwrap();
                if clients.contains("cmd=blpop") { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.unwrap();
        let started = Instant::now();
        if disconnect { disconnect_clients(&state, "test").await.unwrap(); }
        else { release_redis_console_session(&state, &key).unwrap(); }
        assert!(started.elapsed() < Duration::from_millis(250), "release must not await the blocked client lock");
        assert!(timeout(Duration::from_secs(1), blocked).await.unwrap().unwrap().is_err());
        wait_client_count(&mut verifier, 1).await;
        assert!(state.redis_console_connections.lock().unwrap().is_empty());
        assert!(state.redis_console_sessions.lock().unwrap().is_empty());
    }
}
