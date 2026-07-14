import { describe, expect, it } from 'vitest';
import {
  agentInboxTopic,
  agentPositionTopic,
  bridgeIngestTopic,
  operationBroadcastTopic,
  operationWildcardTopic,
  parseAgentTopic,
  parseTeamTopic,
  teamBroadcastTopic,
} from './topics.js';

describe('taxonomia de tópicos MQTT', () => {
  it('constrói o tópico de posição do agente conforme a spec', () => {
    expect(agentPositionTopic('123', '456')).toBe('operacao/123/agente/456/posicao');
  });

  it('constrói o tópico de broadcast da operação', () => {
    expect(operationBroadcastTopic('123')).toBe('operacao/123/broadcast');
  });

  it('constrói o wildcard de escuta da central', () => {
    expect(operationWildcardTopic('123')).toBe('operacao/123/#');
  });

  it('constrói o wildcard de ingest da ponte da API', () => {
    expect(bridgeIngestTopic()).toBe('operacao/+/agente/+/#');
  });

  it('faz parse de um tópico de agente válido', () => {
    expect(parseAgentTopic('operacao/123/agente/456/posicao')).toEqual({
      operationId: '123',
      agentId: '456',
      channel: 'posicao',
    });
  });

  it('rejeita tópicos fora do padrão', () => {
    expect(parseAgentTopic('operacao/123/broadcast')).toBeNull();
    expect(parseAgentTopic('outracoisa/123/agente/456/posicao')).toBeNull();
    expect(parseAgentTopic('operacao/123/agente/456/posicao/extra')).toBeNull();
  });

  // --- Fase 2b: equipe + inbox ---

  it('constrói o tópico de inbox (DM) do agente', () => {
    expect(agentInboxTopic('123', '456')).toBe('operacao/123/agente/456/inbox');
  });

  it('constrói o tópico de broadcast da equipe', () => {
    expect(teamBroadcastTopic('123', 'T1')).toBe('operacao/123/equipe/T1/broadcast');
  });

  it('parseAgentTopic reconhece o canal inbox', () => {
    expect(parseAgentTopic('operacao/123/agente/456/inbox')).toEqual({
      operationId: '123',
      agentId: '456',
      channel: 'inbox',
    });
  });

  it('faz parse de um tópico de equipe válido', () => {
    expect(parseTeamTopic('operacao/123/equipe/T1/broadcast')).toEqual({
      operationId: '123',
      teamId: 'T1',
      channel: 'broadcast',
    });
  });

  it('parseTeamTopic rejeita tópico de agente, e parseAgentTopic rejeita tópico de equipe', () => {
    expect(parseTeamTopic('operacao/123/agente/456/posicao')).toBeNull();
    expect(parseAgentTopic('operacao/123/equipe/T1/broadcast')).toBeNull();
  });
});
