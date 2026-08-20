import {
  FunctionCallingConfigMode,
  GoogleGenAI,
  type FunctionDeclaration
} from '@google/genai';

import { env } from '../utils/env.js';
import type { FavoriteCafe } from './cafeStore.js';
import type { Cafe } from './geminiMaps.js';

export type CafeAgentDecision =
  | { name: 'save_cafe'; cafeNumber: number }
  | { name: 'list_saved_cafes' }
  | { name: 'remove_saved_cafe'; favoriteNumber: number }
  | {
      name: 'plan_cafe_visit';
      cafeNumber: number;
      startTime: string;
      durationMinutes: number;
    }
  | { name: 'none'; reply: string };

const declarations: FunctionDeclaration[] = [
  {
    name: 'save_cafe',
    description: 'Save one cafe from the latest recommendation list. Do not use when the user also specifies a visit time or calendar request.',
    parametersJsonSchema: {
      type: 'object',
      properties: { cafe_number: { type: 'integer', minimum: 1 } },
      required: ['cafe_number']
    }
  },
  {
    name: 'list_saved_cafes',
    description: 'List the cafes this user previously saved.',
    parametersJsonSchema: { type: 'object', properties: {} }
  },
  {
    name: 'remove_saved_cafe',
    description: 'Remove one cafe from the numbered saved-cafe list.',
    parametersJsonSchema: {
      type: 'object',
      properties: { favorite_number: { type: 'integer', minimum: 1 } },
      required: ['favorite_number']
    }
  },
  {
    name: 'plan_cafe_visit',
    description: 'Save a cafe and prepare a Google Calendar event when the user mentions a visit date/time, reminder, schedule, or calendar.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        cafe_number: { type: 'integer', minimum: 1 },
        start_time: {
          type: 'string',
          description: 'An RFC 3339 timestamp with numeric UTC offset.'
        },
        duration_minutes: { type: 'integer', minimum: 30, maximum: 480 }
      },
      required: ['cafe_number', 'start_time']
    }
  }
];

const ai = new GoogleGenAI({
  enterprise: true,
  project: env.GOOGLE_CLOUD_PROJECT,
  location: env.GOOGLE_CLOUD_LOCATION,
  apiVersion: 'v1'
});

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function parseDecision(
  functionCalls: Array<{ name?: string; args?: Record<string, unknown> }> | undefined,
  fallbackText: string
): CafeAgentDecision {
  const call = functionCalls?.[0];
  const args = call?.args ?? {};
  if (call?.name === 'save_cafe') {
    const cafeNumber = integer(args.cafe_number);
    if (cafeNumber) return { name: 'save_cafe', cafeNumber };
  }
  if (call?.name === 'list_saved_cafes') return { name: 'list_saved_cafes' };
  if (call?.name === 'remove_saved_cafe') {
    const favoriteNumber = integer(args.favorite_number);
    if (favoriteNumber) return { name: 'remove_saved_cafe', favoriteNumber };
  }
  if (call?.name === 'plan_cafe_visit') {
    const cafeNumber = integer(args.cafe_number);
    const startTime = typeof args.start_time === 'string' ? args.start_time : '';
    const durationMinutes = integer(args.duration_minutes) ?? 90;
    if (cafeNumber && startTime && !Number.isNaN(Date.parse(startTime))) {
      return { name: 'plan_cafe_visit', cafeNumber, startTime, durationMinutes };
    }
  }
  return {
    name: 'none',
    reply: fallbackText.trim() || '我可以幫你收藏、查看收藏，或安排咖啡行程。'
  };
}

export async function decideCafeAction(input: {
  text: string;
  cafes: Cafe[];
  favorites: FavoriteCafe[];
  now?: Date;
}): Promise<CafeAgentDecision> {
  const now = input.now ?? new Date();
  const cafeList = input.cafes.map((cafe, index) => `${index + 1}. ${cafe.title}`).join('\n') || '(none)';
  const favoriteList = input.favorites.map((cafe, index) => `${index + 1}. ${cafe.title}`).join('\n') || '(none)';
  const response = await ai.models.generateContent({
    model: env.GEMINI_FUNCTION_MODEL,
    contents: [
      `You are the action router for a Traditional Chinese LINE cafe bot. Current time: ${now.toISOString()}. User time zone: ${env.APP_TIME_ZONE}.`,
      'Choose a function only when the user clearly asks to save, list, remove, schedule, remind, or add a cafe visit to a calendar.',
      'Resolve relative dates using the current time. For vague periods: morning 10:00, afternoon 14:00, evening 19:00. Never choose a cafe that is absent from the relevant numbered list.',
      'If no function applies, answer briefly in Traditional Chinese and tell the user supported examples.',
      '',
      'Latest recommendations:',
      cafeList,
      '',
      'Saved cafes:',
      favoriteList,
      '',
      `User message: ${input.text}`
    ].join('\n'),
    config: {
      tools: [{ functionDeclarations: declarations }],
      toolConfig: {
        functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO }
      },
      temperature: 0
    }
  });
  return parseDecision(response.functionCalls, response.text || '');
}

export const geminiActionAgentInternals = { parseDecision };
