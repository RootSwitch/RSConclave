import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeZip, safeName } from '../zip.ts';

test('zip: names that a model id would otherwise break', () => {
  /*
   * Model ids carry colons and slashes - qwen3.6:27b, hf.co/user/repo:Q4_K_M -
   * and Windows refuses both in a filename. Unsanitised, the archive extracts
   * everywhere except the platform most likely to open it.
   */
  assert.equal(safeName('qwen3.6:27b'), 'qwen3.6-27b');
  assert.equal(safeName('hf.co/user/repo:Q4_K_M'), 'hf.co-user-repo-Q4_K_M');
  assert.equal(safeName('..\evil'), 'evil');
  assert.equal(safeName('trailing. '), 'trailing');
  assert.equal(safeName('...'), 'unnamed');
  assert.equal(safeName(''), 'unnamed');
});

test('zip: a real archive that a real unzipper can read', () => {
  /*
   * Byte-layout code passes its own unit tests happily while producing an
   * archive nothing will open, so this shells out to an actual extractor
   * rather than trusting the writer to grade itself.
   */
  const files = [
    { name: '01-alpha.md', text: '# Alpha\n\n' + 'compressible '.repeat(500) },
    { name: '02-beta.md', text: 'tiny' }, // deflate would grow this; must store
    { name: '03-unicode.md', text: 'em dash test — ünïcödé ✓' },
  ];
  const zip = makeZip(files);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'starts with a local file header');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsz-'));
  fs.writeFileSync(path.join(dir, 'a.zip'), zip);
  /*
   * Finding a real extractor is fiddlier than it looks. Windows ships bsdtar
   * as System32\tar.exe, which reads zip - but on a machine with Git Bash,
   * plain `tar` resolves to GNU tar instead, which cannot read zip at all and
   * additionally treats "C:\..." as a remote host. So the absolute path is
   * used where it exists, and every command runs with cwd set and a relative
   * filename so no drive letter is ever parsed as a host.
   */
  const candidates: Array<[string, string[]]> = [
    ['C:/Windows/System32/tar.exe', ['-xf', 'a.zip']],
    ['unzip', ['-q', 'a.zip']],
    ['tar', ['-xf', 'a.zip']],
  ];
  let extracted = false;
  let lastErr = '';
  for (const [cmd, args] of candidates) {
    try {
      execFileSync(cmd, args, { cwd: dir, stdio: 'pipe' });
      extracted = true;
      break;
    } catch (err: any) {
      lastErr = `${cmd}: ${err?.message ?? err}`;
    }
  }
  assert.ok(extracted, `no extractor accepted the archive - last: ${lastErr}`);
  for (const f of files) {
    const got = fs.readFileSync(path.join(dir, f.name), 'utf8');
    assert.equal(got, f.text, `${f.name} round-tripped intact`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('zip: an empty archive is still a valid one', () => {
  const zip = makeZip([]);
  assert.equal(zip.length, 22, 'just the end-of-central-directory record');
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
});
