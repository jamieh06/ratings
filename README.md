# TV Ratings

A personal TV ratings app in the macOS Tahoe look, for Mac and iPhone: rate episodes, seasons and whole shows from 0.0 to 10.0, see your top episodes, seasons and shows, a diary of what you rated, and stats.

- Ratings are kept in this browser and synced to the To Do app's Supabase (sync.js), so the TV (inside Free My TV), the Mac and the iPhone share one set. Sign in once in the To Do app (same site). Export and Import still use the Free My TV row shape plus `kind`.
- On the TV it runs inside Free My TV in TV mode (`?tv=1`, tv.js): the remote's arrows move focus, Back closes.
- Show data, posters and stills come from TMDB. Without a key it shows 10 sample shows; paste your own TMDB key in Search to look up any show (it is kept only in your browser).
- Works offline after the first visit and can be added to the Dock or Home Screen.

This product uses the TMDB API but is not endorsed or certified by TMDB.
