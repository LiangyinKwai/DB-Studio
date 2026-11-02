"""Finder layout for the distributable DMG; compatible with headless CI."""
from pathlib import Path

application = Path(defines['app']).resolve()  # supplied by dmgbuild -D
background = str(Path(defines['background']).resolve())
files = [str(application)]
symlinks = {'Applications': '/Applications'}
format = 'UDZO'
icon_locations = {application.name: (165, 169), 'Applications': (495, 169)}
window_rect = ((160, 160), (660, 400))
default_view = 'icon-view'
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
arrange_by = None
icon_size = 88
text_size = 13
