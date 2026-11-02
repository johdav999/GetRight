const fixture = new URL(location.href).searchParams.get('fixture');
if (!/^uat-[a-f0-9]{32}$/.test(fixture ?? '')) throw new Error('A valid isolated fixture ID is required.');
const key = `getright:${fixture}`;
const title = document.querySelector('#title');
const body = document.querySelector('#body');
const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
if (saved) { title.value = saved.title; body.value = saved.body; }
document.querySelector('#fixture').textContent = `Fixture: ${fixture}`;
document.querySelector('#save').addEventListener('click', () => {
  try {
    localStorage.setItem(key, JSON.stringify({ title: title.value, body: body.value }));
    document.querySelector('#confirmation').textContent = 'Note saved successfully.';
  } catch {
    document.querySelector('#confirmation').textContent = 'Your note could not be saved. Please retry.';
  }
});
