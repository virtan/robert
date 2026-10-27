import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ChatRequest, ContentPart } from '../src/openrouter.ts';
import { ALICE, command, completion, GROUP, Harness, mention, OWNER } from './harness.ts';

let h: Harness;
beforeEach(() => (h = new Harness()));
afterEach(() => h.close());

const lastUserParts = (req: ChatRequest): ContentPart[] => {
  const c = req.messages.filter((m) => m.role === 'user').at(-1)!.content;
  return typeof c === 'string' ? [{ type: 'text', text: c }] : (c as ContentPart[]);
};
const allText = (req: ChatRequest) => JSON.stringify(req.messages);

describe('groups and approval', () => {
  test('ignores and does not store groups the owner has not approved', async () => {
    await h.addToGroup(ALICE);
    const notice = h.sent().find((c) => c.payload.chat_id === OWNER.id);
    assert.ok(notice, 'owner gets an approval request');
    assert.match(String(notice.payload.text), /added me to "Friends"/);

    await h.send(mention('@robert_test_bot hi'));
    assert.equal(h.mainRequests().length, 0);
    assert.equal(h.db.recent(GROUP.id, 0, 10).length, 0);
  });

  test('owner approves with the inline button', async () => {
    await h.addToGroup(ALICE);
    await h.update({ callback_query: { id: 'q', from: OWNER, chat_instance: 'c', data: `ap:${GROUP.id}`, message: { message_id: 5, date: 0, chat: { id: OWNER.id, type: 'private', first_name: 'Olga' } } } } as never);
    assert.equal(h.db.getChat(GROUP.id)?.status, 'approved');
    assert.ok(h.sent().some((c) => c.payload.chat_id === GROUP.id && /I'm Robert/.test(String(c.payload.text))), 'greets the group');
  });

  test('owner adding the bot approves the group immediately', async () => {
    await h.addToGroup(OWNER);
    assert.equal(h.db.getChat(GROUP.id)?.status, 'approved');
  });

  test('DMs from strangers are refused once', async () => {
    const dm = { id: ALICE.id, type: 'private' as const, first_name: 'Alice' };
    await h.send({ text: 'hi' }, dm);
    await h.send({ text: 'hello?' }, dm);
    assert.equal(h.mainRequests().length, 0);
    assert.equal(h.sent().filter((c) => c.payload.chat_id === ALICE.id).length, 1);
  });
});

describe('answering', () => {
  beforeEach(async () => {
    await h.addToGroup(OWNER);
    h.calls.length = 0;
  });

  test('listens silently, then answers a direct mention with context', async () => {
    await h.send({ text: 'We land in Lisbon on Friday', from: OWNER });
    h.chatReplies.push(completion('Lisbon on **Friday** — have fun!'));
    const ask = await h.send(mention('@robert_test_bot when do we land?'));

    const [req] = h.mainRequests().map((r) => r.body as unknown as ChatRequest);
    assert.ok(allText(req).includes('We land in Lisbon on Friday'), 'earlier message is in context');
    assert.match(String(req.messages[0].content), /You're Robert/);
    assert.ok(req.tools?.some((t) => t.type === 'openrouter:web_search'));
    assert.match(JSON.stringify(lastUserParts(req)), new RegExp(`addressed you directly in message #${ask.message_id}`));

    const reply = h.sent().at(-1)!;
    assert.equal(reply.payload.text, 'Lisbon on <b>Friday</b> — have fun!');
    assert.equal(reply.payload.parse_mode, 'HTML');
    assert.deepEqual((reply.payload.reply_parameters as { message_id: number }).message_id, ask.message_id);
    assert.ok(h.db.recent(GROUP.id, 0, 10).some((m) => m.is_self && m.text?.includes('Lisbon')), 'own reply stored');
  });

  test('responds to its name in plain text and to replies', async () => {
    h.chatReplies.push(completion('yes'), completion('sure'));
    await h.send({ text: 'Robert, are you there?' });
    const botMsg = h.sent().at(-1)!;
    await h.send({ text: 'and now?', reply_to_message: { message_id: 1000 + 0, from: { id: 99, is_bot: true, first_name: 'Robert' }, chat: GROUP, date: 0 } as never });
    assert.ok(botMsg);
    assert.equal(h.mainRequests().length, 2);
  });

  test('NOREPLY sends nothing', async () => {
    h.chatReplies.push(completion('NOREPLY'));
    await h.send({ text: 'robert is a nice name' });
    assert.equal(h.mainRequests().length, 1);
    assert.equal(h.sent().length, 0);
  });

  test('judge decides on implicit requests', async () => {
    h.judgeReply = { respond: false };
    await h.send({ text: 'what should we eat tonight?' });
    assert.equal(h.mainRequests().length, 0, 'judge said no');

    h.judgeReply = { respond: true, message_id: null };
    h.chatReplies.push(completion('Try the ramen place.'));
    const ask = await h.send({ text: 'can the bot find a good restaurant nearby?' });
    const req = h.mainRequests()[0].body as unknown as ChatRequest;
    assert.match(JSON.stringify(lastUserParts(req)), /seems to be asking you/);
    assert.equal((h.sent().at(-1)!.payload.reply_parameters as { message_id: number }).message_id, ask.message_id);
  });

  test('a follow-up sent while Robert is answering is still considered', async () => {
    let followUp: { message_id: number } | undefined;
    h.chatReplies.push(async () => {
      followUp = await h.deliver({ text: 'and how long is the flight?' });
      await new Promise((r) => setTimeout(r, 20));
      return completion('It is 25°C in Lisbon.');
    });
    h.judgeReply = { respond: true };
    h.chatReplies.push(completion('About 3 hours.'));
    await h.send({ text: 'Robert, weather in Lisbon?' });
    await h.robert.idle();
    const replies = h.sent().map((c) => c.payload);
    assert.deepEqual(replies.map((p) => p.text), ['It is 25°C in Lisbon.', 'About 3 hours.']);
    assert.equal((replies[1].reply_parameters as { message_id: number }).message_id, followUp!.message_id);
  });

  test('direct mode never calls the judge', async () => {
    h.db.setChatMode(GROUP.id, 'direct');
    h.judgeReply = { respond: true };
    await h.send({ text: 'anyone know a plumber?' });
    assert.equal(h.orRequests.length, 0);
  });

  test('runs tools and continues the conversation', async () => {
    h.chatReplies.push(
      completion(null, [{ name: 'create_reminder', args: { when: '2099-01-02 09:30', text: 'Book tickets' } }]),
      (req) => {
        const tool = req.messages.at(-1)!;
        assert.equal(tool.role, 'tool');
        assert.match(String(tool.content), /Reminder #1 set for 2099-01-02 09:30/);
        return completion('Done, I will remind you.');
      },
    );
    await h.send({ text: 'Robert remind us on Jan 2 2099 at 9:30 to book tickets' });
    assert.equal(h.db.listReminders(GROUP.id)[0].text, 'Book tickets');
    assert.equal(h.sent().at(-1)!.payload.text, 'Done, I will remind you.');
  });

  test('due reminders are delivered', async () => {
    h.db.addReminder({ chat_id: GROUP.id, thread_id: null, created_by: ALICE.id, created_by_name: 'Alice', due_at: 1, text: 'Stand up!', repeat: 'daily' });
    await h.robert.tickReminders();
    assert.match(String(h.sent().at(-1)!.payload.text), /⏰ Stand up!/);
    assert.ok(h.db.listReminders(GROUP.id)[0].due_at > Date.now() / 1000, 'daily reminder rescheduled');
  });

  test('generated images are sent to the chat', async () => {
    h.chatReplies.push(completion(null, [{ name: 'generate_image', args: { prompt: 'a cat in a hat' } }]), completion('Here it is!'));
    await h.send({ text: 'Robert draw a cat in a hat' });
    assert.equal(h.sent('sendPhoto').length, 1);
    assert.ok(h.orRequests.some((r) => r.path === '/images' && r.body.prompt === 'a cat in a hat'));
    assert.equal(h.sent().at(-1)!.payload.text, 'Here it is!');
  });

  test('photos are attached as images', async () => {
    h.chatReplies.push(completion('A cat.'));
    await h.send({ photo: [{ file_id: 'small', file_unique_id: 's', width: 90, height: 90, file_size: 100 }, { file_id: 'big', file_unique_id: 'b', width: 1280, height: 1280, file_size: 5000 }], caption: 'Robert what is this?' });
    assert.ok(h.calls.some((c) => c.method === 'getFile' && c.payload.file_id === 'big'));
    const req = h.mainRequests()[0].body as unknown as ChatRequest;
    const img = lastUserParts(req).find((p) => p.type === 'image_url');
    assert.ok(img && img.type === 'image_url' && img.image_url.url.startsWith('data:image/jpeg;base64,'));
  });

  test('models that cannot see get a description instead', async () => {
    h.db.setChatModel(GROUP.id, 'vendor/blind');
    h.chatReplies.push(completion('A photo of a cat (from description).'));
    await h.send({ photo: [{ file_id: 'p', file_unique_id: 'p', width: 10, height: 10, file_size: 10 }], caption: 'Robert?' });
    const vision = h.orRequests.find((r) => r.body.model === h.config.models.vision);
    assert.ok(vision, 'vision model described the image');
    const main = h.orRequests.find((r) => r.body.model === 'vendor/blind')!.body as unknown as ChatRequest;
    assert.ok(!JSON.stringify(main).includes('image_url'));
    assert.ok(!main.tools, 'no tools for a model without tool support');
  });

  test('voice messages are transcribed, and a spoken name triggers an answer', async () => {
    h.transcript = 'Robert, what is the capital of Peru?';
    h.chatReplies.push(completion('Lima.'));
    await h.send({ voice: { file_id: 'v', file_unique_id: 'v', duration: 4, mime_type: 'audio/ogg', file_size: 3000 } });
    const stt = h.orRequests.find((r) => r.path === '/audio/transcriptions')!;
    assert.equal((stt.body.input_audio as { format: string }).format, 'ogg');
    const req = h.mainRequests()[0].body as unknown as ChatRequest;
    assert.match(allText(req), /Transcript: Robert, what is the capital of Peru\?/);
    assert.equal(h.sent().at(-1)!.payload.text, 'Lima.');
  });

  test('text documents are read inline', async () => {
    h.chatReplies.push(completion('ok'));
    await h.send({ document: { file_id: 'd', file_unique_id: 'd', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 7 }, caption: 'Robert summarize' });
    const row = h.db.recent(GROUP.id, 0, 5).find((m) => m.kind === 'document')!;
    assert.ok(row.extracted, 'text extracted');
  });

  test('model errors are reported in the chat', async () => {
    h.chatReplies.push(() => {
      throw new Error('boom');
    });
    await h.send({ text: 'Robert hi' });
    assert.match(String(h.sent().at(-1)!.payload.text), /went wrong/);
  });

  test('daily budget stops paid calls', async () => {
    h.config.dailyBudgetUsd = 0.001;
    h.db.addUsage({ kind: 'chat', model: 'x', cost: 1 });
    await h.send({ text: 'Robert hi' });
    assert.equal(h.mainRequests().length, 0);
    assert.match(String(h.sent().at(-1)!.payload.text), /spending limit/);
  });
});

describe('commands', () => {
  beforeEach(async () => {
    await h.addToGroup(OWNER);
    h.calls.length = 0;
  });

  test('only the owner can switch models', async () => {
    await h.send(command('/model opus'));
    assert.match(String(h.sent().at(-1)!.payload.text), /Only the owner/);
    assert.equal(h.db.getChat(GROUP.id)?.model, null);

    await h.send({ ...command('/model opus'), from: OWNER });
    assert.equal(h.db.getChat(GROUP.id)?.model, 'anthropic/claude-opus-5.5');
  });

  test('owner can switch models in natural language through a tool', async () => {
    h.chatReplies.push(completion(null, [{ name: 'switch_model', args: { query: 'opus' } }]), completion('Switched.'));
    await h.send({ text: 'Robert, switch to Opus please', from: OWNER });
    assert.equal(h.db.getChat(GROUP.id)?.model, 'anthropic/claude-opus-5.5');

    h.chatReplies.push(completion(null, [{ name: 'switch_model', args: { query: 'blind' } }]), (req) => {
      assert.match(String(req.messages.at(-1)!.content), /only the owner/i);
      return completion('Sorry, only the owner can do that.');
    });
    await h.send({ text: 'Robert switch to blind' });
    assert.equal(h.db.getChat(GROUP.id)?.model, 'anthropic/claude-opus-5.5');
  });

  test('/forget erases the chat', async () => {
    await h.send({ text: 'secret plans' });
    await h.send({ ...command('/forget'), from: OWNER });
    assert.equal(h.db.search(GROUP.id, 'secret', 5).length, 0);
  });

  test('/status reports model and spending', async () => {
    await h.send(command('/status'));
    assert.match(String(h.sent().at(-1)!.payload.text), /Model: meta\/muse-spark-open/);
  });
});

describe('memory', () => {
  test('older messages are folded into a summary', async () => {
    h.close();
    h = new Harness({ historyTokens: 300 });
    await h.addToGroup(OWNER);
    for (let i = 0; i < 45; i++) h.db.insertMessage({ chat_id: GROUP.id, tg_id: 5000 + i, thread_id: null, user_id: 2, user_name: 'Alice', username: 'alice', date: 1, reply_to: null, forwarded_from: null, kind: 'text', text: `message number ${i} about the trip to Lisbon and the hotel booking`, media_path: null, media_mime: null, media_name: null, duration: null });
    h.chatReplies.push(completion('Alice planned a Lisbon trip.'));
    assert.equal(await h.robert.brain.maybeSummarize(GROUP.id), true);
    const chat = h.db.getChat(GROUP.id)!;
    assert.equal(chat.summary, 'Alice planned a Lisbon trip.');
    assert.ok(chat.summary_upto > 0);

    h.chatReplies.push(completion('ok'));
    await h.send({ text: 'Robert, recap?' });
    const req = h.mainRequests().at(-1)!.body as unknown as ChatRequest;
    assert.match(String(req.messages[0].content), /Alice planned a Lisbon trip/);
    assert.ok(!allText(req).includes('message number 0 '), 'summarized messages are not repeated raw');
  });

  test('history search finds older messages', () => {
    h.db.upsertChat(GROUP.id, 'supergroup', 'Friends');
    h.db.insertMessage({ chat_id: GROUP.id, tg_id: 1, thread_id: null, user_id: 2, user_name: 'Alice', username: 'alice', date: 1, reply_to: null, forwarded_from: null, kind: 'text', text: 'The flight is AF1234 at 7am', media_path: null, media_mime: null, media_name: null, duration: null });
    h.db.insertMessage({ chat_id: GROUP.id, tg_id: 2, thread_id: null, user_id: 3, user_name: 'Bob', username: 'bob', date: 1, reply_to: null, forwarded_from: null, kind: 'voice', text: null, extracted: 'Мы прилетаем в субботу', media_path: null, media_mime: null, media_name: null, duration: 3 });
    assert.equal(h.db.search(GROUP.id, 'flight', 5)[0].tg_id, 1);
    assert.equal(h.db.search(GROUP.id, 'прилетаем', 5)[0].tg_id, 2);
    assert.equal(h.db.search(GROUP.id, '', 5, { from: '@bob' })[0].tg_id, 2);
    assert.equal(h.db.search(GROUP.id, 'flight', 5, { from: 'bob' }).length, 0);
  });
});
