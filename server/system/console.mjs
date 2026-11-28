import { createInterface } from 'node:readline';
import { announcementSummary } from './announcements.mjs';

/** Local stdin only: no remote endpoint and no synthetic staff/player session. */
export function createServerConsole(relay, { input = process.stdin, output = process.stdout } = {}) {
  const write = text => output.write(text + '\n');
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  lines.on('line', async line => {
    const match = /^\/?(\S+)(?:[ \t]+(.*))?$/u.exec(line.trim());
    if (!match) return;
    const command = match[1].toLowerCase();
    if (command === 'help' || command === 'aide') {
      write('Console: announce <message> · fake-call [name|SteamID64|555-XXXX] · help');
      return;
    }
    if(command==='fake-call'){
      try{const result=await relay.fakeCall(match[2]??'');write(result.ok?`Test call sent to ${result.player} (${result.number}).`:String(result.error));}catch{write('Test call failed.');}return;
    }
    if (command !== 'annonce' && command !== 'announce') {
      write('Unknown command. Type help to list console commands.');
      return;
    }
    try {
      const result = relay.announce(match[2] ?? '');
      if (!result.ok) write('Usage: announce <message> (1 to 240 characters, without control characters).');
      else write(announcementSummary(result));
    } catch (error) {
      write('Announcement failed: ' + String(error?.message ?? error).replace(/[\r\n]/g, ' ').slice(0, 160));
    }
  });
  lines.on('error', error => write('Console unavailable: ' + String(error.message).replace(/[\r\n]/g, ' ').slice(0, 160)));
  return { close() { lines.close(); } };
}
