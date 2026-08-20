import type { messagingApi } from '@line/bot-sdk';

import {
  createFavoritesMessage,
  createPendingConfirmation,
  createWelcomeMessage
} from '../messages/cafeMessages.js';
import {
  createPendingAction,
  getRecommendationContext,
  listFavorites
} from '../services/cafeStore.js';
import { decideCafeAction } from '../services/geminiActionAgent.js';

function text(message: string): messagingApi.TextMessage {
  return { type: 'text', text: message };
}

export async function handleCafeText(input: {
  ownerId: string;
  conversationId: string;
  text: string;
}): Promise<messagingApi.Message[]> {
  if (/^(開始|start|help|幫助)$/iu.test(input.text.trim())) return [createWelcomeMessage()];

  const [cafes, favorites] = await Promise.all([
    getRecommendationContext(input.ownerId, input.conversationId),
    listFavorites(input.ownerId)
  ]);
  const decision = await decideCafeAction({ text: input.text, cafes, favorites });

  if (decision.name === 'none') return [text(decision.reply)];
  if (decision.name === 'list_saved_cafes') return [createFavoritesMessage(favorites)];

  if (decision.name === 'remove_saved_cafe') {
    const favorite = favorites[decision.favoriteNumber - 1];
    if (!favorite) return [text('找不到這筆收藏，請先說「查看我的收藏」確認編號。')];
    const pending = await createPendingAction({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      kind: 'remove',
      cafe: { title: favorite.title, uri: favorite.uri },
      favoriteId: favorite.id
    });
    return [createPendingConfirmation(pending)];
  }

  const cafe = cafes[decision.cafeNumber - 1];
  if (!cafe) return [text('找不到這間推薦，請重新傳送位置後再試一次。')];

  if (decision.name === 'plan_cafe_visit') {
    const start = new Date(decision.startTime);
    if (start.getTime() <= Date.now()) return [text('行程時間必須在未來，請告訴我新的日期和時間。')];
    const pending = await createPendingAction({
      ownerId: input.ownerId,
      conversationId: input.conversationId,
      kind: 'visit',
      cafe,
      startTime: start.toISOString(),
      durationMinutes: Math.min(Math.max(decision.durationMinutes, 30), 480)
    });
    return [createPendingConfirmation(pending)];
  }

  const pending = await createPendingAction({
    ownerId: input.ownerId,
    conversationId: input.conversationId,
    kind: 'save',
    cafe
  });
  return [createPendingConfirmation(pending)];
}
