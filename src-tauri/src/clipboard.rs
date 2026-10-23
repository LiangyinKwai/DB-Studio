use std::sync::{mpsc, OnceLock};
use tokio::sync::oneshot;

struct WriteRequest {
    text: String,
    reply: oneshot::Sender<Result<(), String>>,
}

// Keep the OS clipboard alive (required on Linux), and serialize operations on
// one thread. Database reads may complete after WebView user activation ends.
static WRITER: OnceLock<Result<mpsc::Sender<WriteRequest>, String>> = OnceLock::new();

pub async fn write_text(text: String) -> Result<(), String> {
    let writer = WRITER
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel::<WriteRequest>();
            std::thread::Builder::new()
                .name("db-studio-clipboard".into())
                .spawn(move || {
                    let mut clipboard = None;
                    for request in receiver {
                        let result = (|| {
                            if clipboard.is_none() {
                                clipboard = Some(
                                    arboard::Clipboard::new()
                                        .map_err(|error| format!("打开系统剪贴板失败：{error}"))?,
                                );
                            }
                            clipboard
                                .as_mut()
                                .unwrap()
                                .set_text(request.text)
                                .map_err(|error| format!("写入系统剪贴板失败：{error}"))
                        })();
                        let _ = request.reply.send(result);
                    }
                })
                .map_err(|error| format!("启动剪贴板服务失败：{error}"))?;
            Ok(sender)
        })
        .as_ref()
        .map_err(Clone::clone)?;
    let (reply, result) = oneshot::channel();
    writer
        .send(WriteRequest { text, reply })
        .map_err(|_| "剪贴板服务已退出".to_string())?;
    result
        .await
        .map_err(|_| "剪贴板服务未返回结果".to_string())?
}
