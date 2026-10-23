import type { CatalogModel } from '../src/openrouter.ts';

export function fakeModel(id: string, name: string, created: number, inputs = ['text', 'image'], tools = true): CatalogModel {
  return {
    id, name, created, context_length: 200000,
    architecture: { input_modalities: inputs, output_modalities: ['text'] },
    pricing: { prompt: '0.000002', completion: '0.00001' },
    supported_parameters: tools ? ['tools', 'max_tokens'] : ['max_tokens'],
  };
}
