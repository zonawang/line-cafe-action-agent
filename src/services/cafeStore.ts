import { Firestore, Timestamp } from '@google-cloud/firestore';

import { env } from '../utils/env.js';
import type { Cafe } from './geminiMaps.js';

export type FavoriteCafe = Cafe & {
  id: string;
  savedAtMs: number;
};

export type PendingCafeAction = {
  id: string;
  ownerId: string;
  conversationId: string;
  kind: 'save' | 'remove' | 'visit';
  cafe: Cafe;
  favoriteId?: string;
  startTime?: string;
  durationMinutes?: number;
  expiresAtMs: number;
};

type StoredContext = {
  ownerId: string;
  conversationId: string;
  cafes: Cafe[];
  createdAt: Timestamp;
  expiresAt: Timestamp;
};

type StoredFavorite = Cafe & { savedAt: Timestamp };

type StoredPending = Omit<PendingCafeAction, 'id' | 'expiresAtMs'> & {
  createdAt: Timestamp;
  expiresAt: Timestamp;
  status: 'pending' | 'completed';
};

const CONTEXT_TTL_MS = 30 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

const firestore = new Firestore({ projectId: env.GOOGLE_CLOUD_PROJECT });
const contexts = firestore.collection(env.FIRESTORE_CONTEXT_COLLECTION);
const favoriteOwners = firestore.collection(env.FIRESTORE_FAVORITES_COLLECTION);
const pendingActions = firestore.collection(env.FIRESTORE_PENDING_COLLECTION);

function favorites(ownerId: string) {
  return favoriteOwners.doc(ownerId).collection('items');
}

export async function saveRecommendationContext(input: {
  ownerId: string;
  conversationId: string;
  cafes: Cafe[];
}): Promise<void> {
  const now = Date.now();
  await contexts.doc(input.ownerId).set({
    ...input,
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + CONTEXT_TTL_MS)
  } satisfies StoredContext);
}

export async function getRecommendationContext(
  ownerId: string,
  conversationId: string
): Promise<Cafe[]> {
  const snapshot = await contexts.doc(ownerId).get();
  if (!snapshot.exists) return [];
  const data = snapshot.data() as StoredContext;
  if (data.conversationId !== conversationId || data.expiresAt.toMillis() <= Date.now()) {
    return [];
  }
  return data.cafes;
}

export async function listFavorites(ownerId: string): Promise<FavoriteCafe[]> {
  const snapshot = await favorites(ownerId).orderBy('savedAt', 'desc').limit(20).get();
  return snapshot.docs.map((document) => {
    const data = document.data() as StoredFavorite;
    return {
      id: document.id,
      title: data.title,
      uri: data.uri,
      savedAtMs: data.savedAt.toMillis()
    };
  });
}

export async function createPendingAction(
  input: Omit<PendingCafeAction, 'id' | 'expiresAtMs'>
): Promise<PendingCafeAction> {
  const now = Date.now();
  const document = pendingActions.doc();
  const stored: StoredPending = {
    ...input,
    createdAt: Timestamp.fromMillis(now),
    expiresAt: Timestamp.fromMillis(now + PENDING_TTL_MS),
    status: 'pending'
  };
  await document.set(stored);
  return { ...input, id: document.id, expiresAtMs: stored.expiresAt.toMillis() };
}

export class PendingActionError extends Error {
  constructor(public readonly code: 'not_found' | 'expired' | 'forbidden' | 'completed') {
    super(`Pending cafe action unavailable: ${code}`);
  }
}

export async function executePendingAction(
  pendingId: string,
  ownerId: string,
  conversationId: string
): Promise<PendingCafeAction> {
  const document = pendingActions.doc(pendingId);

  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(document);
    if (!snapshot.exists) throw new PendingActionError('not_found');
    const data = snapshot.data() as StoredPending;
    if (data.ownerId !== ownerId || data.conversationId !== conversationId) {
      throw new PendingActionError('forbidden');
    }
    if (data.expiresAt.toMillis() <= Date.now()) throw new PendingActionError('expired');
    if (data.status !== 'pending') throw new PendingActionError('completed');

    if (data.kind === 'remove') {
      if (!data.favoriteId) throw new Error('Remove action has no favorite id');
      transaction.delete(favorites(ownerId).doc(data.favoriteId));
    } else {
      transaction.set(favorites(ownerId).doc(document.id), {
        ...data.cafe,
        savedAt: Timestamp.now()
      } satisfies StoredFavorite);
    }
    transaction.update(document, { status: 'completed' });
    return {
      id: document.id,
      ownerId: data.ownerId,
      conversationId: data.conversationId,
      kind: data.kind,
      cafe: data.cafe,
      favoriteId: data.favoriteId,
      startTime: data.startTime,
      durationMinutes: data.durationMinutes,
      expiresAtMs: data.expiresAt.toMillis()
    };
  });
}

export async function cancelPendingAction(
  pendingId: string,
  ownerId: string,
  conversationId: string
): Promise<void> {
  const document = pendingActions.doc(pendingId);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(document);
    if (!snapshot.exists) return;
    const data = snapshot.data() as StoredPending;
    if (data.ownerId !== ownerId || data.conversationId !== conversationId) {
      throw new PendingActionError('forbidden');
    }
    transaction.delete(document);
  });
}
