// Synthetic WriterApp-shaped host for testing Getright's adapter/API contracts.
// This is not a WriterApp application build and cannot establish live UAT acceptance.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export async function createWriterAppContractHost() {
  const state = { version: '0.1.100.42', userId: 'contract-uat-account', creates: 0, documents: new Map() };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = value => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)); };
    if (url.pathname === '/api/app/version') return json(state.versionPayload ?? { version: state.version });
    if (url.pathname === '/api/auth/me') return json(state.authPayload ?? { isAuthenticated: true, userId: state.userId });
    if (url.pathname === '/api/onboarding/complete' && request.method === 'POST') return json({ hasCompletedOnboarding: true });
    if (url.pathname === '/api/documents' && request.method === 'POST') {
      state.creates++;
      const document = { id: randomUUID(), title: 'Untitled', sectionId: randomUUID(), pageId: randomUUID(), content: '' };
      state.documents.set(document.id, document);
      return json({ document, defaultSectionId: document.sectionId });
    }
    const document = [...state.documents.values()].find(d => url.pathname.includes(d.id) || url.pathname.includes(d.sectionId) || url.pathname.includes(d.pageId));
    if (url.pathname.startsWith('/api/documents/') && document) return json(document);
    if (url.pathname.startsWith('/api/sections/') && document) return json([{ id: document.pageId, content: document.content }]);
    if (url.pathname.startsWith('/api/pages/') && request.method === 'PUT' && document) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      document.content = JSON.parse(Buffer.concat(chunks).toString()).content; return json(document);
    }
    if (url.pathname.startsWith('/app/documents')) {
      response.setHeader('Content-Type', 'text/html');
      return response.end(`<!doctype html><html lang="en"><title>Synthetic WriterApp contract host</title><body>
        <div class="prosa-library"><h1>Documents</h1><button id="create">Create new document</button></div>
        <div class="editor-surface" hidden><div class="ProseMirror" contenteditable="true" role="textbox"></div><button id="actions" aria-label="Document actions">Actions</button><div role="group" aria-label="Document actions" hidden><button id="save">Save now</button></div></div>
        <script>
        let documentId = ${JSON.stringify(document?.id ?? null)}, pageId = ${JSON.stringify(document?.pageId ?? null)};
        const editor = window.document.querySelector('.ProseMirror');
        function showEditor(content) { window.document.querySelector('.prosa-library').hidden = true; window.document.querySelector('.editor-surface').hidden = false; editor.textContent = content; }
        if (documentId) showEditor(${JSON.stringify(document?.content ?? '')});
        window.document.querySelector('#create').onclick = async () => { const created = await (await fetch('/api/documents', { method: 'POST' })).json(); documentId = created.document.id; pageId = created.document.pageId; history.pushState({}, '', '/app/documents/' + documentId); showEditor(''); };
        window.document.querySelector('#actions').onclick = () => window.document.querySelector('[role=group]').hidden = false;
        window.document.querySelector('#save').onclick = async () => { await fetch('/api/pages/' + pageId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: editor.textContent }) }); };
        </script></body></html>`);
    }
    response.statusCode = 404; response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
