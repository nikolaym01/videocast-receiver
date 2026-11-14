# VideoCast receiver

The Cast receiver page for [VideoCast](https://github.com/nikolaym01/video-cast-from-mac), a macOS app that
casts files and screens to a Chromecast. It's Google's Cast Application Framework player with:

- a faster start (plays once about 2 s are buffered),
- a quiet idle screen instead of Google's,
- diagnostics sent back to VideoCast on `urn:x-cast:com.videocast` (position, dropped frames, buffering
  time, player events), and an on-screen debug log VideoCast can switch on.

VideoCast loads media with the standard Cast LOAD/SEEK messages, so it falls back to Google's Default Media
Receiver when this one isn't available.

Served by GitHub Pages; register its URL as a Custom Receiver in the
[Google Cast SDK Developer Console](https://cast.google.com/publish) to get an application ID.

License: MIT.
