import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from '../src/models.ts';
import { fakeModel } from './fixtures.ts';

const catalog = new Catalog({ models: async () => [] }, null);
catalog.load([
  fakeModel('anthropic/claude-opus-5', 'Anthropic: Claude Opus 5', 100),
  fakeModel('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', 200),
  fakeModel('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 190),
  fakeModel('google/gemini-3.8-flash', 'Google: Gemini 3.8 Flash', 180, ['text', 'image', 'audio', 'file']),
  fakeModel('openai/gpt-6.1-sol', 'OpenAI: GPT-6.1 Sol', 170, ['text', 'image', 'file']),
  fakeModel('vendor/tiny', 'Tiny', 10, ['text'], false),
]);

test('resolves loose names to the newest match', () => {
  assert.equal(catalog.resolve('opus').match?.id, 'anthropic/claude-opus-5.5');
  assert.equal(catalog.resolve('claude opus 5').match?.id, 'anthropic/claude-opus-5');
  assert.equal(catalog.resolve('Sonnet').match?.id, 'anthropic/claude-sonnet-5.5');
  assert.equal(catalog.resolve('gemini flash').match?.id, 'google/gemini-3.8-flash');
  assert.equal(catalog.resolve('gpt 6.1').match?.id, 'openai/gpt-6.1-sol');
  assert.equal(catalog.resolve('openai/gpt-6.1-sol').match?.id, 'openai/gpt-6.1-sol');
  assert.equal(catalog.resolve('llama').match, undefined);
});

test('capabilities', () => {
  assert.ok(catalog.supports('google/gemini-3.8-flash', 'audio'));
  assert.ok(!catalog.supports('vendor/tiny', 'image'));
  assert.ok(!catalog.supports('vendor/tiny', 'tools'));
  assert.ok(catalog.supports('unknown/model', 'image'), 'unknown models are assumed capable');
});
