import { readFile, writeFile } from 'node:fs/promises';

const [artifact, version, sourceCommit] = process.argv.slice(2);
if (version !== process.env.GETRIGHT_BUILD_VERSION || sourceCommit !== process.env.GETRIGHT_SOURCE_COMMIT)
  throw new Error('Expected the recipe build version and source commit.');
const receipt = JSON.stringify({ version, sourceCommit, userId: 'notes-uat', isolated: true });
await writeFile(artifact, `const receipt = ${receipt};\n${await readFile('app.mjs', 'utf8')}`);
