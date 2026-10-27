import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog, isGeneric, modelLine } from '../src/models.ts';
import { fakeModel } from './fixtures.ts';

const catalog = new Catalog({ models: async () => [] }, null);
catalog.load([
  fakeModel('anthropic/claude-opus-5', 'Anthropic: Claude Opus 5', 100),
  fakeModel('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', 200),
  fakeModel('anthropic/claude-sonnet-5.5', 'Anthropic: Claude Sonnet 5.5', 190),
  fakeModel('google/gemini-3.8-flash', 'Google: Gemini 3.8 Flash', 180, ['text', 'image', 'audio', 'file']),
  fakeModel('openai/gpt-6.1-sol', 'OpenAI: GPT-6.1 Sol', 170, ['text', 'image', 'file']),
  fakeModel('vendor/tiny', 'Tiny', 10, ['text'], false),
  fakeModel('anthropic/claude-opus-5.5:batch', 'Anthropic: Claude Opus 5.5 (batch)', 201),
  fakeModel('openrouter/free', 'Free Models Router', 300),
  fakeModel('x-ai/grok-4.6', 'SpaceXAI: Grok 4.6', 150),
  fakeModel('x-ai/grok-4.7', 'SpaceXAI: Grok 4.7', 160),
  fakeModel('x-ai/grok-4.7-preview', 'SpaceXAI: Grok 4.7 Preview', 165),
  fakeModel('meta/muse-wonder', 'Meta: Muse Wonder', 140),
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

test('routers and variants appear only when named', () => {
  assert.equal(catalog.resolve('models').match, undefined, 'generic words match nothing');
  assert.equal(catalog.resolve('opus 5.5').match?.id, 'anthropic/claude-opus-5.5');
  assert.ok(!catalog.resolve('router').candidates.some((m) => m.id.includes(':')));
  assert.equal(catalog.resolve('free').match?.id, 'openrouter/free');
  assert.equal(catalog.resolve('opus batch').match?.id, 'anthropic/claude-opus-5.5:batch');
  assert.equal(catalog.resolve('grok').match?.id, 'x-ai/grok-4.7', 'stable beats a newer preview');
});

test('featured lists presets, then the newest stable model of each family', () => {
  const ids = catalog.featured(['google/gemini-3.8-flash']).map((m) => m.id);
  assert.equal(ids[0], 'google/gemini-3.8-flash');
  for (const id of ['anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'openai/gpt-6.1-sol', 'x-ai/grok-4.7', 'meta/muse-wonder']) {
    assert.ok(ids.includes(id), id);
  }
  for (const id of ['anthropic/claude-opus-5', 'x-ai/grok-4.6', 'x-ai/grok-4.7-preview', 'openrouter/free', 'anthropic/claude-opus-5.5:batch', 'vendor/tiny']) {
    assert.ok(!ids.includes(id), id);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('generic queries and short lines', () => {
  assert.ok(isGeneric(''));
  assert.ok(isGeneric('available models'));
  assert.ok(isGeneric('Доступные модели'));
  assert.ok(!isGeneric('opus'));
  assert.equal(modelLine(catalog.get('x-ai/grok-4.7')!), 'Grok 4.7 — x-ai/grok-4.7 ($2/$10 per M; image)');
});
