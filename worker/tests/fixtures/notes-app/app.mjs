import { randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

const [origin, data] = process.argv.slice(2);
const url = new URL(origin);
if (url.hostname !== '127.0.0.1' || origin !== process.env.GETRIGHT_UAT_ORIGIN || !data || data !== process.env.GETRIGHT_UAT_DATA)
  throw new Error('Use an owned loopback host and disposable data directory.');
const heading = 'Isolated notes';
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const notePath = id => path.join(data, `${id}.json`);
const readNote = async id => JSON.parse(await readFile(notePath(id), 'utf8'));
const saveNote = note => writeFile(notePath(note.id), JSON.stringify(note));

async function readInput(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2048) throw new Error('Request body is too large.');
  }
  return JSON.parse(body);
}

const server = createServer(async (request, response) => {
  const target = new URL(request.url, origin);
  const { method } = request;
  const json = (status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  try {
    if (method === 'GET' && ['/_getright/runtime', '/_getright/fixtures'].includes(target.pathname)) return json(200, receipt);
    if (method === 'POST' && target.pathname === '/_getright/fixtures/note') {
      const { fixtureId } = await readInput(request);
      if (!/^uat-[a-f0-9]{32}$/.test(fixtureId)) return json(400, {});
      const note = { fixtureId, id: randomUUID(), text: '' };
      await saveNote(note);
      return json(201, note);
    }
    const owned = new RegExp(`^/_getright/fixtures/note/(${uuid})$`).exec(target.pathname);
    if (owned) {
      const note = await readNote(owned[1]);
      if (note.fixtureId !== request.headers['x-getright-fixture']) return json(404, {});
      if (method === 'GET') return json(200, { id: note.id, fixtureId: note.fixtureId });
      if (method === 'DELETE') {
        await unlink(notePath(note.id));
        return response.writeHead(204).end();
      }
    }
    const resource = new RegExp(`^/api/notes/(${uuid})$`).exec(target.pathname);
    if (resource) {
      const note = await readNote(resource[1]);
      if (method === 'GET') return json(200, note);
      if (method === 'PUT') {
        const { text } = await readInput(request);
        if (typeof text !== 'string' || text.length > 1500) return json(400, {});
        note.text = text;
        await saveNote(note);
        return json(200, note);
      }
    }
    if (method === 'GET' && target.pathname === '/notes') {
      const id = target.searchParams.get('id') ?? '';
      if (!id) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end(`<!doctype html><html lang="en"><title>${heading}</title><h1>${heading}</h1><p>Run the isolated workflow to provision a note.</p></html>`);
      }
      if (!new RegExp(`^${uuid}$`).test(id)) return json(400, {});
      const note = await readNote(id);
      const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(`<!doctype html><html lang="en"><title>${heading}</title><h1>${heading}</h1>
        <label for="note">Note</label><textarea id="note">${escape(note.text)}</textarea>
        <button id="save">Save note</button><p role="status"></p>
        <script>
        document.getElementById('save').onclick = async () => {
          const text = document.getElementById('note').value;
          const result = await fetch('/api/notes/${id}', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
          document.querySelector('[role="status"]').textContent = result.ok ? 'Note saved.' : 'Save failed.';
        };
        </script></html>`);
    }
    return json(404, {});
  } catch (error) {
    return json(error.code === 'ENOENT' ? 404 : 400, {});
  }
});
server.listen(Number(url.port), url.hostname);
