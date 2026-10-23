import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from 'grammy/types';
import { isDirect, nameRegex, parseCommand } from '../src/triggers.ts';

const group = { id: -100, type: 'supergroup', title: 'G' } as const;
const msg = (over: Partial<Message>): Message =>
  ({ message_id: 1, date: 0, chat: group, from: { id: 5, is_bot: false, first_name: 'Ann' }, ...over }) as Message;
const opts = { botId: 99, botUsername: 'robert_bot', names: nameRegex(['Robert', 'Роберт*', 'Bob']) };

test('name matching respects word boundaries and stems', () => {
  const re = nameRegex(['Robert', 'Роберт*'])!;
  assert.ok(re.test('Robert, help'));
  assert.ok(re.test('hey robert?'));
  assert.ok(!re.test('Roberto is here'));
  assert.ok(!re.test('Robertson'));
  assert.ok(re.test('спроси Роберта'));
  assert.ok(re.test('Роберт, привет'));
});

test('direct triggers', () => {
  assert.ok(isDirect(msg({ text: 'Bob what time is it' }), opts));
  assert.ok(!isDirect(msg({ text: 'what time is it' }), opts));
  assert.ok(isDirect(msg({ text: 'hi @robert_bot', entities: [{ type: 'mention', offset: 3, length: 11 }] }), opts));
  assert.ok(isDirect(msg({ text: 'thanks', reply_to_message: msg({ from: { id: 99, is_bot: true, first_name: 'R' } }) as never }), opts));
  assert.ok(isDirect(msg({ chat: { id: 5, type: 'private', first_name: 'Ann' }, text: 'anything' }), opts));
  assert.ok(isDirect(msg({ voice: {} as never }), { ...opts, extra: 'Роберту передай' }));
});

test('forum topic root is not a reply to the bot', () => {
  const root = msg({ message_id: 7, from: { id: 99, is_bot: true, first_name: 'R' } });
  assert.ok(!isDirect(msg({ text: 'x', is_topic_message: true, message_thread_id: 7, reply_to_message: root as never }), opts));
});

test('commands', () => {
  const cmd = (text: string) => msg({ text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] });
  assert.deepEqual(parseCommand(cmd('/model opus 5'), 'robert_bot'), { name: 'model', args: 'opus 5' });
  assert.deepEqual(parseCommand(cmd('/Help@Robert_Bot'), 'robert_bot'), { name: 'help', args: '' });
  assert.equal(parseCommand(cmd('/help@other_bot'), 'robert_bot'), null);
  assert.equal(parseCommand(msg({ text: 'no command' }), 'robert_bot'), null);
});
