#!/usr/bin/env python3
"""Verify Finder settings on a mounted DB Studio installer image."""
import sys
from pathlib import Path
from ds_store import DSStore

mount = Path(sys.argv[1])
with DSStore.open(str(mount / '.DS_Store'), 'r') as store:
    entries = {(entry.filename, entry.code): entry.value for entry in store}
assert entries[('.', b'icvl')] == b'icnv', 'installer must use icon view'
assert entries[('.', b'bwsp')]['WindowBounds'].endswith('{660, 400}}'), 'unexpected window size'
view = entries[('.', b'icvp')]
assert view['backgroundType'] == 2 and view['iconSize'] == 88, 'missing background or unexpected icon size'
assert entries[('DB Studio.app', b'Iloc')] == (165, 169), 'unexpected application position'
assert entries[('Applications', b'Iloc')] == (495, 169), 'unexpected Applications position'
assert (mount / 'Applications').is_symlink() and (mount / 'Applications').readlink() == Path('/Applications')
assert (mount / '.background.tiff').is_file(), 'HiDPI background missing'
print('Finder layout and installer contents verified')
