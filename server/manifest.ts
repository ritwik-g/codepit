/**
 * The web app manifest, so CodePit can be added to a phone's home screen and open
 * full screen like an app.
 *
 * A home-screen app keeps its own cookies, apart from the browser's, so on first
 * launch it pairs as a device of its own.
 */
export function webManifest() {
  return {
    id: '/',
    name: 'CodePit',
    short_name: 'CodePit',
    description: 'Your coding agents, in one place',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    // The dark theme's --bg and the page's theme-color
    background_color: '#0a0a0c',
    theme_color: '#0e0f12',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
