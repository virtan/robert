import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { Update } from 'grammy/types';
import { unglue } from '../src/brain.ts';
import { DB } from '../src/db.ts';
import type { ChatRequest } from '../src/openrouter.ts';
import { runJs } from '../src/sandbox/run.ts';
import { command, completion, GROUP, Harness, OWNER } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = new Harness();
  await h.addToGroup(OWNER);
  h.calls.length = 0;
});
afterEach(() => h.close());

const lastRequest = () => h.mainRequests().at(-1)!.body as unknown as ChatRequest;
const allText = (req: ChatRequest) => JSON.stringify(req.messages);
const IGOR = { id: 7, is_bot: false, first_name: 'Igor', username: 'igor' };

describe('replies and edits', () => {
  test('headers quote the message being replied to', async () => {
    const first = await h.send({ text: 'There are exactly two solutions to this puzzle', from: OWNER });
    await h.send({ text: 'Robert, are you sure?', reply_to_message: first as never });
    assert.match(allText(lastRequest()), /↩ #\d+ Olga: \\"There are exactly two solutions to this puzzle\\"/);
  });

  test('replies to messages Robert never saw use the text Telegram sends along', async () => {
    const old = { message_id: 5, date: 1, chat: GROUP, from: OWNER, text: 'An old message from before Robert joined' };
    await h.send({ text: 'Robert, what about this?', reply_to_message: old as never });
    assert.match(allText(lastRequest()), /↩ #5: \\"An old message from before Robert joined\\"/);
  });

  test('edits replace the text, are marked, and an edit that adds the name gets an answer', async () => {
    const m = await h.send({ text: 'what time is the train' });
    assert.equal(h.mainRequests().length, 0);
    h.chatReplies.push(completion('At 9:15.'));
    await h.update({ edited_message: { ...m, text: 'Robert, what time is the train?', edit_date: m.date + 30 } } as Omit<Update, 'update_id'>);
    assert.equal(h.db.getMessage(GROUP.id, m.message_id)?.text, 'Robert, what time is the train?');
    assert.match(allText(lastRequest()), /edited \d\d:\d\d/);
    assert.equal(h.sent().at(-1)!.payload.text, 'At 9:15.');

    // Editing it again doesn't trigger another answer.
    await h.update({ edited_message: { ...m, text: 'Robert, what time is the train tomorrow?', edit_date: m.date + 60 } } as Omit<Update, 'update_id'>);
    assert.equal(h.mainRequests().length, 1);
  });
});

describe('waiting tasks', () => {
  test('a task waits for a person and runs on their next message', async () => {
    await h.send({ text: 'hi all', from: IGOR as typeof OWNER });
    h.chatReplies.push(
      completion(null, [{ name: 'watch_for_message', args: { person: 'Igor', task: 'Suggest the caching change to Igor.' } }]),
      (req) => {
        assert.match(String(req.messages.at(-1)!.content), /Waiting task #1 saved: when Igor \(@igor\) next writes/);
        return completion('Will do when Igor is back.');
      },
    );
    await h.send({ text: 'Robert, when Igor writes, suggest the caching change to him', from: OWNER });
    assert.equal(h.db.listWatches(GROUP.id).length, 1);

    await h.send({ text: 'unrelated chatter' });
    assert.equal(h.mainRequests().length, 2, 'other people do not trigger it');

    h.chatReplies.push(completion('Igor, here is the caching idea…'));
    await h.send({ text: 'morning', from: IGOR as typeof OWNER });
    assert.match(allText(lastRequest()), /asked you to do this when Igor \(@igor\) showed up: \\"Suggest the caching change to Igor.\\"/);
    assert.equal(h.sent().at(-1)!.payload.text, 'Igor, here is the caching idea…');
    assert.equal(h.db.listWatches(GROUP.id).length, 0, 'the task runs once');
  });

  test('tasks show up in list_reminders and can be cancelled', async () => {
    h.db.addWatch({ chat_id: GROUP.id, thread_id: null, created_by: 1, created_by_name: 'Olga', user_id: null, user_key: 'igor', task: 'say hi', expires_at: Math.floor(Date.now() / 1000) + 100 });
    h.chatReplies.push(completion(null, [{ name: 'list_reminders', args: {} }, { name: 'cancel_reminder', args: { id: 1, kind: 'watch' } }]), (req) => {
      const results = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
      assert.match(results[0], /watch #1 when igor writes/);
      assert.equal(results[1], 'Cancelled.');
      return completion('Cancelled it.');
    });
    await h.send({ text: 'Robert, cancel the Igor task', from: OWNER });
    assert.equal(h.db.listWatches(GROUP.id).length, 0);
  });
});

describe('reliability', () => {
  test('an empty answer is retried once', async () => {
    h.chatReplies.push(completion(''), completion('Here I am.'));
    await h.send({ text: 'Robert?' });
    assert.equal(h.mainRequests().length, 2);
    assert.equal(h.sent().at(-1)!.payload.text, 'Here I am.');
  });

  test('two empty answers produce a visible notice', async () => {
    h.chatReplies.push(completion(''), completion(''));
    await h.send({ text: 'Robert?' });
    assert.match(String(h.sent().at(-1)!.payload.text), /empty answer/);
  });

  test('a failed answer the judge picked is reported, but not repeatedly', async () => {
    h.judgeReply = { respond: true };
    h.chatReplies.push(() => ({ error: { message: 'Provider returned error', code: 429 } }));
    await h.send({ text: 'can the bot check the weather?' });
    const notices = () => h.sent().filter((c) => /⚠️/.test(String(c.payload.text))).length;
    assert.equal(notices(), 1);
    h.chatReplies.push(() => ({ error: { message: 'Provider returned error', code: 429 } }));
    await h.send({ text: 'can the bot check again?' });
    assert.equal(notices(), 1);
  });

  test('/names changes what Robert answers to', async () => {
    await h.send({ ...command('/names Robert, Роб, Роби'), from: OWNER });
    assert.deepEqual(h.config.names, ['Robert', 'Роб', 'Роби']);
    h.chatReplies.push(completion('Тут я.'));
    await h.send({ text: 'Роб, куда ты пропал?' });
    assert.equal(h.sent().at(-1)!.payload.text, 'Тут я.');
  });
});

describe('grounding', () => {
  test('the system prompt states the real model and the facts about Robert', async () => {
    await h.send({ text: 'Robert, which model are you?' });
    const system = String(lastRequest().messages[0].content);
    assert.match(system, new RegExp(`Your answers come from the model ${h.config.models.chat.replace('/', '\\/')}`));
    assert.match(system, /You see the last ~24k tokens/);
    assert.match(system, /Message ids are for your tools only/);
  });

  test('switching models explains what happens to memory', async () => {
    await h.send({ ...command('/model opus'), from: OWNER });
    assert.match(String(h.sent().at(-1)!.payload.text), /Memory carries over/);
  });

  test('search finds emoji exactly and in order', () => {
    const add = (tg: number, text: string) => h.db.insertMessage({ chat_id: GROUP.id, tg_id: tg, thread_id: null, user_id: 2, user_name: 'Alice', username: 'alice', date: tg, reply_to: null, forwarded_from: null, kind: 'text', text, media_path: null, media_mime: null, media_name: null, duration: null });
    add(1, 'no emoji here');
    add(2, 'party 🎉 time');
    add(3, 'again 🎉🎉');
    assert.deepEqual(h.db.search(GROUP.id, '🎉', 5, { order: 'oldest' }).map((m) => m.tg_id), [2, 3]);
    assert.deepEqual(h.db.search(GROUP.id, '🎉', 5, { order: 'newest' }).map((m) => m.tg_id), [3, 2]);
    assert.equal(h.db.search(GROUP.id, '🙂', 5).length, 0);
  });

  test('text glued around web searches is split into paragraphs', () => {
    assert.equal(unglue('Сейчас проверю цену.Игорь, проверил: 999$.'), 'Сейчас проверю цену.\n\nИгорь, проверил: 999$.');
    assert.equal(unglue('Use `foo.Bar()` and e.g. Node.js here.'), 'Use `foo.Bar()` and e.g. Node.js here.');
  });
});

describe('sandbox', () => {
  test('runs code and returns output', async () => {
    assert.equal(await runJs('console.log(6*6); 6+6'), 'Output:\n36\nResult: 12');
  });

  test('has no access to the host', async () => {
    assert.equal(await runJs('[typeof process, typeof require, typeof fetch, typeof setTimeout].join()'), 'Result: undefined,undefined,undefined,undefined');
    assert.match(await runJs('this.constructor.constructor("return process")()'), /ReferenceError: 'process' is not defined/);
    assert.match(await runJs('import("fs")'), /could not load module/);
  });

  test('stops runaway code', async () => {
    assert.match(await runJs('while (true) {}', { timeoutMs: 300 }), /Stopped: the code ran longer/);
    assert.match(await runJs('const a = []; while (true) a.push("x".repeat(1e6))'), /out of memory/);
  });

  test('is offered as a tool unless disabled', async () => {
    await h.send({ text: 'Robert, 2+2?' });
    assert.ok(lastRequest().tools?.some((t) => 'function' in t && t.function.name === 'run_js'));
    h.config.runCode = false;
    await h.send({ text: 'Robert, 3+3?' });
    assert.ok(!lastRequest().tools?.some((t) => 'function' in t && t.function.name === 'run_js'));
  });
});

test('old databases get the new columns', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'robert-db-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, tg_id INTEGER, thread_id INTEGER, user_id INTEGER, user_name TEXT, username TEXT, is_self INTEGER NOT NULL DEFAULT 0, date INTEGER NOT NULL, reply_to INTEGER, forwarded_from TEXT, kind TEXT NOT NULL, text TEXT, extracted TEXT, description TEXT, media_path TEXT, media_mime TEXT, media_name TEXT, duration INTEGER)');
  old.close();
  const db = new DB(file);
  const cols = (db.sql.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('edited_at') && cols.includes('reply_quote'));
  db.close();
  fs.rmSync(path.dirname(file), { recursive: true });
});
