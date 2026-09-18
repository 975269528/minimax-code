import { describe, expect, it } from 'vitest';

import type { LocalRuntimeConfig } from '../contracts.js';
import { listLocalRuntimeModels, resolveLocalRuntimeModelKey } from './catalog.js';

function config(overrides: Partial<LocalRuntimeConfig> = {}): LocalRuntimeConfig {
  return {
    dataDir: '/tmp/model-catalog-test',
    provider: {},
    ...overrides,
  };
}

describe('listLocalRuntimeModels', () => {
  it('uses the configured default model and variant when no selection is supplied', () => {
    const entries = listLocalRuntimeModels(
      config({
        defaultModel: 'builtin/base',
        defaultModelVariant: 'thinking',
        provider: {
          builtin: {
            name: 'Builtin',
            api: 'openai-responses',
            options: { authMode: 'api-key' },
            models: {
              base: {
                thinking_config: { mode: 'switchable', default_value: 'false' },
                variants: { thinking: {}, 'none-thinking': {} },
              },
            },
          },
        },
      }),
    );

    expect(entries).toEqual([
      expect.objectContaining({
        providerId: 'builtin',
        providerName: 'Builtin',
        modelId: 'base',
        apiFormat: 'openai-responses',
        selected: true,
        variant: 'thinking',
      }),
    ]);
  });

  it('uses an explicit selection and attaches cached custom-provider status', () => {
    const entries = listLocalRuntimeModels(
      config({
        defaultModel: 'builtin/base',
        provider: {
          builtin: {
            options: { authMode: 'api-key' },
            models: { base: {} },
          },
        },
        custom_provider: {
          work: {
            api: 'openai-completions',
            models: {
              historical: {},
              added: {
                reasoning: true,
                thinking_config: { mode: 'switchable', default_value: 'true' },
              },
            },
          },
        },
      }),
      { providerId: 'custom_provider:work', modelId: 'added', variant: undefined },
      {
        cache: {
          version: 3,
          provider_status: {},
          model_status: {
            'builtin/base': {
              state: 'available',
              last_tested_at: 1_750_000_000_000,
            },
          },
        },
        implicitCustomProviderThinking: true,
      },
    );

    expect(entries).toEqual([
      expect.objectContaining({
        providerId: 'builtin',
        modelId: 'base',
        selected: false,
        status: { state: 'available', lastTestedAt: 1_750_000_000_000 },
      }),
      expect.objectContaining({
        providerId: 'custom_provider:work',
        providerName: 'work',
        modelId: 'historical',
        apiFormat: 'openai-completions',
        selected: false,
        thinkingConfig: { mode: 'switchable', default_value: 'false' },
        variant: '',
      }),
      expect.objectContaining({
        providerId: 'custom_provider:work',
        providerName: 'work',
        modelId: 'added',
        apiFormat: 'openai-completions',
        selected: true,
        thinkingConfig: { mode: 'switchable', default_value: 'true' },
        variant: 'thinking',
      }),
    ]);
  });

  it('reports the resolved managed MiniMax API protocol without model-name inference', () => {
    const entries = listLocalRuntimeModels(
      config({
        minimaxModelSource: 'minimax_api_key',
        provider: { minimax: { models: { 'MiniMax-M3': {} } } },
      }),
    );

    expect(entries).toContainEqual(
      expect.objectContaining({
        providerId: 'minimax',
        modelId: 'MiniMax-M3',
        apiFormat: 'anthropic-messages',
      }),
    );
  });

  it.each(['model-without-provider', '/model', 'provider/'])(
    'ignores an incomplete default model key %#',
    (defaultModel) => {
      expect(listLocalRuntimeModels(config({ defaultModel }))).toEqual([]);
    },
  );
});

describe('resolveLocalRuntimeModelKey', () => {
  const modelConfig = config({
    provider: {
      minimax: {
        name: 'MiniMax',
        options: { authMode: 'api-key' },
        models: {
          'MiniMax-M2.7': { name: 'MiniMax-M2.7' },
          'MiniMax-M2.7-highspeed': { name: 'MiniMax-M2.7-highspeed' },
          'MiniMax-M3': { name: 'MiniMax-M3' },
        },
      },
    },
  });

  it('keeps an exact source-qualified model key', () => {
    expect(resolveLocalRuntimeModelKey(modelConfig, 'minimax/MiniMax-M3')).toEqual({
      kind: 'resolved',
      modelKey: 'minimax/MiniMax-M3',
    });
  });

  it('normalizes a unique model shorthand to its source-qualified key', () => {
    expect(resolveLocalRuntimeModelKey(modelConfig, 'M3')).toEqual({
      kind: 'resolved',
      modelKey: 'minimax/MiniMax-M3',
    });
  });

  it('returns every candidate instead of guessing when shorthand is ambiguous', () => {
    expect(resolveLocalRuntimeModelKey(modelConfig, '2.7')).toEqual({
      kind: 'ambiguous',
      candidates: ['minimax/MiniMax-M2.7', 'minimax/MiniMax-M2.7-highspeed'],
    });
  });

  it('reports a model name that does not exist in the current catalog', () => {
    expect(resolveLocalRuntimeModelKey(modelConfig, 'imaginary-model')).toEqual({
      kind: 'not_found',
    });
  });
});
