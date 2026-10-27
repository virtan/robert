import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { looksSecret } from '../src/memory.ts';
import type { ChatRequest } from '../src/openrouter.ts';
import { command, completion, GROUP, Harness, OWNER } from './harness.ts';

let h: Harness;
beforeEach(async () => {
  h = new Harness({}, { memoryIdleMs: 20 });
  await h.addToGroup(OWNER);
  h.calls.length = 0;
});
afterEach(() => h.close());

const BOB = { id: 3, is_bot: false, first_name: 'Bob', username: 'bob' } as typeof OWNER;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('long-term memory', () => {
  test('new messages are read into memory, attributed to whoever said them', async () => {
    const msgs = [];
    for (const text of ['We move to Porto on 2026-12-01', 'My new address is Rua das Flores 12', 'ok', 'cool', 'nice']) {
      msgs.push(await h.send({ text, from: BOB }));
    }
    h.memoryReply = {
      add: [
        { category: 'plan', about: 'Bob', fact: 'Bob moves to Porto on 2026-12-01', message_id: msgs[0].message_id },
        { category: 'place', about: 'Bob', fact: 'Bob lives at Rua das Flores 12, Porto', message_id: msgs[1].message_id },
        { category: 'contact', about: 'Bob', fact: 'Bob\'s seed phrase is apple banana …', message_id: msgs[1].message_id },
      ],
    };
    await sleep(40);
    await h.robert.idle();
    const mem = h.db.listMemories(GROUP.id);
    assert.equal(mem.length, 2, 'the secret is not stored');
    assert.ok(mem.every((m) => m.said_by === 'Bob' && m.said_by_id === BOB.id));
    assert.equal(h.db.getChat(GROUP.id)!.memory_upto, h.db.recent(GROUP.id, 0, 1)[0].id);

    // The next batch only contains new messages, and sees what's stored.
    h.memoryReply = { add: [], update: [{ id: mem.find((m) => m.category === 'plan')!.id, fact: 'Bob moves to Porto on 2026-12-15' }], remove: [] };
    for (const text of ['Move postponed to the 15th', 'a', 'b', 'c', 'd']) await h.send({ text, from: BOB });
    await sleep(40);
    await h.robert.idle();
    const req = h.memoryRequests().at(-1)!.body as unknown as ChatRequest;
    assert.match(String(req.messages[1].content), /Bob moves to Porto on 2026-12-01/);
    assert.ok(!String(req.messages[1].content).includes('My new address'), 'already-read messages are not sent again');
    assert.ok(h.db.listMemories(GROUP.id).some((m) => m.fact === 'Bob moves to Porto on 2026-12-15'));
  });

  test('memories are in the prompt and searchable; /memory lists them; /forget erases them', async () => {
    h.db.addMemory({ chat_id: GROUP.id, category: 'date', about: 'Anna', fact: 'Anna\'s birthday is March 3', said_by: 'Anna', said_by_id: 5, source_tg_id: 1 });
    await h.send({ text: 'Robert, when is Anna\'s birthday?' });
    const system = String((h.mainRequests().at(-1)!.body as unknown as ChatRequest).messages[0].content);
    assert.match(system, /Long-term memory of this chat[\s\S]*\[date\] Anna: Anna's birthday is March 3/);

    await h.send(command('/memory birthday'));
    assert.match(String(h.sent().at(-1)!.payload.text), /birthday is March 3/);
    await h.send({ ...command('/forget'), from: OWNER });
    assert.equal(h.db.countMemories(GROUP.id), 0);
  });

  test('remember refuses secrets, and only the owner or the author can delete', async () => {
    h.chatReplies.push(
      completion(null, [
        { name: 'remember', args: { category: 'contact', about: 'Bob', fact: 'Bob\'s ETH wallet is 0x52908400098527886E0F7030069857D2E4169EE7' } },
        { name: 'remember', args: { category: 'contact', fact: 'Bob\'s password is hunter2' } },
      ]),
      (req) => {
        const results = req.messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
        assert.match(results[0], /Saved as memory #1/);
        assert.match(results[1], /Refused/);
        return completion('Noted the wallet.');
      },
    );
    await h.send({ text: 'Robert remember my wallet', from: BOB });
    assert.equal(h.db.countMemories(GROUP.id), 1);

    h.chatReplies.push(completion(null, [{ name: 'forget_memory', args: { id: 1 } }]), (req) => {
      assert.match(String(req.messages.at(-1)!.content), /Refused/);
      return completion('Only Bob or the owner can.');
    });
    await h.send({ text: 'Robert forget Bob\'s wallet' });
    assert.equal(h.db.countMemories(GROUP.id), 1);

    h.chatReplies.push(completion(null, [{ name: 'forget_memory', args: { id: 1 } }]), completion('Forgotten.'));
    await h.send({ text: 'Robert forget my wallet', from: BOB });
    assert.equal(h.db.countMemories(GROUP.id), 0);
  });

  test('can be turned off', async () => {
    h.config.memory = false;
    for (let i = 0; i < 6; i++) await h.send({ text: `message ${i}` });
    await sleep(40);
    await h.robert.idle();
    assert.equal(h.memoryRequests().length, 0);
    await h.send({ text: 'Robert hi' });
    const req = h.mainRequests().at(-1)!.body as unknown as ChatRequest;
    assert.ok(!req.tools?.some((t) => 'function' in t && t.function.name === 'remember'));
  });
});

test('secret detection', () => {
  for (const s of ['my seed phrase is …', 'пароль от wifi 12345', 'key 4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', 'card 4111 1111 1111 1111', '-----BEGIN RSA PRIVATE KEY-----']) {
    assert.ok(looksSecret(s), s);
  }
  for (const s of ['Bob\'s ETH wallet is 0x52908400098527886E0F7030069857D2E4169EE7', 'Call Anna at +351 912 345 678', 'Meeting on 2026-12-01 at 10:00']) {
    assert.ok(!looksSecret(s), s);
  }
});
