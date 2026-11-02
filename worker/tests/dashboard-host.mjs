import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { repositoryRoot, api } from '../src/settings.mjs';
import { cleanEnvironment, launchProcess, stopProcess, boundedLog } from '../src/processes.mjs';
import { freePort } from '../src/writerapp-host.mjs';

export async function dashboardHost(dataPath, { environment = {} } = {}) {
  await mkdir(dataPath, { recursive: true });
  const origin = `http://127.0.0.1:${await freePort()}`;
  const projectPath = path.join(repositoryRoot, 'src/Getright.Dashboard');
  let child, output = '';
  async function start() {
    output = ''; const log = boundedLog(path.join(dataPath, 'dashboard.log'));
    child = launchProcess('dotnet', [process.env.GETRIGHT_DASHBOARD_DLL || path.join(projectPath, 'bin/Release/net10.0/Getright.Dashboard.dll'), '--urls', origin], {
      cwd: projectPath, env: { ...cleanEnvironment(), ASPNETCORE_ENVIRONMENT: 'Production', Getright__DataPath: dataPath, ...environment },
      log: value => { log(value); output = (output + value).slice(-6000); },
    });
    let error; child.once('error', value => { error = value; });
    for (let i = 0; i < 100; i++) {
      if (error) throw error;
      if (child.exitCode !== null) throw new Error(`Getright dashboard exited: ${output}`);
      try { await api(origin, '/api/health'); return; } catch { await delay(200); }
    }
    throw new Error(`Getright dashboard did not start. ${output}`);
  }
  async function stop() { await stopProcess(child); }
  await start(); return { origin, dataPath, start, stop };
}
