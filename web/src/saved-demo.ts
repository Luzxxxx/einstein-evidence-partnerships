// The public build replays captured GET responses; it never forwards an API call.
export const savedDemo = import.meta.env.VITE_SAVED_DEMO === 'true';
type SavedRoute = { file: string; contentType: string; status: number };
type SavedManifest = { routes: Record<string, SavedRoute> };

export function installSavedDemo() {
  if (!savedDemo) return;
  const nativeFetch = window.fetch.bind(window);
  const manifest = nativeFetch('/demo-data/manifest.json').then(async response => {
    if (!response.ok) throw new Error('SAVED_DEMO_UNAVAILABLE');
    return await response.json() as SavedManifest;
  });
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return nativeFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (method.toUpperCase() !== 'GET') return Response.json({ code: 'MODEL_CONFIG_MISSING' }, { status: 405 });
    const route = (await manifest).routes[url.pathname];
    if (!route) return Response.json({ code: 'RUN_NOT_FOUND' }, { status: 404 });
    const response = await nativeFetch(`/demo-data/${route.file}`, { signal: init?.signal, credentials: 'omit' });
    if (!response.ok) throw new Error('SAVED_DEMO_UNAVAILABLE');
    return new Response(response.body, { status: route.status, headers: { 'Content-Type': route.contentType } });
  };
}
