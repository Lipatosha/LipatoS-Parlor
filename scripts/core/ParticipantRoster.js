/**
 * ParticipantRoster — 参赛角色辅助
 *
 * 这层后续维护统一按 Foundry V14 兼容优先来收。
 * 只处理赌场里的“谁在参赛、谁在控制、名字头像怎么拿”。
 */

const PLAYER_PREFIX = 'actor:';
// 没绑角色时，先给玩家一个 user: 席位顶着，省得单人桌直接掉线。
const USER_PREFIX = 'user:';
const NPC_PREFIX = 'npc:';
const BOT_PREFIX = 'bot:';
const t = (key, data) => data ? game.i18n.format(key, data) : game.i18n.localize(key);

export function getPlayerParticipantId(actorId) {
    return actorId ? `${PLAYER_PREFIX}${actorId}` : null;
}

export function getUserParticipantId(userId) {
    return userId ? `${USER_PREFIX}${userId}` : null;
}

export function getNpcParticipantId(actorId) {
    return actorId ? `${NPC_PREFIX}${actorId}` : null;
}

export function getBotParticipantId(actorId) {
    return actorId ? `${BOT_PREFIX}${actorId}` : null;
}

export function isPlayerParticipantId(participantId) {
    const id = String(participantId || '');
    // user: 虽然没角色，但在桌上还是玩家席。
    return id.startsWith(PLAYER_PREFIX) || id.startsWith(USER_PREFIX);
}

export function isUserParticipantId(participantId) {
    return String(participantId || '').startsWith(USER_PREFIX);
}

export function isNpcParticipantId(participantId) {
    return String(participantId || '').startsWith(NPC_PREFIX);
}

export function isBotParticipantId(participantId) {
    const id = String(participantId || '');
    return id.startsWith('bot_') || id.startsWith(BOT_PREFIX);
}

export function getActorIdFromParticipantId(participantId) {
    const id = String(participantId || '');
    if (id.startsWith(PLAYER_PREFIX)) return id.slice(PLAYER_PREFIX.length) || null;
    if (isNpcParticipantId(id)) return id.slice(NPC_PREFIX.length) || null;
    if (id.startsWith(BOT_PREFIX)) return id.slice(BOT_PREFIX.length) || null;
    return null;
}

export function getParticipantAvatar(actor, fallback = null) {
    return actor?.img || actor?.prototypeToken?.texture?.src || fallback || null;
}

export function createUserParticipant(user) {
    if (!user) return null;
    const actor = user.character || null;

    return normalizeParticipant({
        // 有角色就跟角色走；没有就退回用户席位，至少还能正常入桌和记筹码。
        id: actor ? getPlayerParticipantId(actor.id) : getUserParticipantId(user.id),
        type: 'user',
        actorId: actor?.id || null,
        userId: user.id,
        controllerId: user.id,
        name: actor?.name || user.name || t('PARLOR.Participant.UnnamedActor'),
        avatar: getParticipantAvatar(actor, user.avatar || null),
        ownerName: actor ? (user.name || '') : ''
    });
}

export function createNpcParticipant(actor, controllerId = game.user?.id || null) {
    if (!actor) return null;

    return normalizeParticipant({
        id: getNpcParticipantId(actor.id),
        type: 'npc',
        actorId: actor.id,
        userId: null,
        controllerId,
        name: actor.name || t('PARLOR.Participant.NPCName'),
        avatar: getParticipantAvatar(actor, null),
        ownerName: t('PARLOR.Participant.DMOwner')
    });
}

export function createNpcBotParticipant(actor, { botMode = 'random' } = {}) {
    if (!actor) return null;

    return normalizeParticipant({
        id: getBotParticipantId(actor.id),
        type: 'bot',
        actorId: actor.id,
        userId: null,
        controllerId: null,
        botMode,
        name: actor.name || t('PARLOR.Participant.NPCName'),
        avatar: getParticipantAvatar(actor, null),
        ownerName: t('PARLOR.Participant.DMOwner')
    });
}

export function normalizeParticipant(participant) {
    if (!participant?.id) return null;

    const type = participant.type || (isNpcParticipantId(participant.id) ? 'npc' : (isBotParticipantId(participant.id) ? 'bot' : 'user'));
    const user = participant.userId ? game.users?.get(participant.userId) : null;
    const actor = participant.actorId ? game.actors?.get(participant.actorId) : null;
    const safeBotMode = ['win', 'lose', 'random'].includes(participant.botMode) ? participant.botMode : 'random';

    return {
        id: participant.id,
        type,
        actorId: participant.actorId || null,
        userId: participant.userId || null,
        controllerId: participant.controllerId || participant.userId || null,
        botMode: type === 'bot' ? safeBotMode : null,
        name: participant.name || actor?.name || user?.name || String(participant.id),
        avatar: participant.avatar || getParticipantAvatar(actor, user?.avatar || null),
        ownerName: participant.ownerName || user?.name || (type === 'npc' ? t('PARLOR.Participant.DMOwner') : '')
    };
}

export function getParticipants(source) {
    const list = Array.isArray(source) ? source : (source?.participants || []);
    return list.map(normalizeParticipant).filter(Boolean);
}

export function getParticipant(source, participantId) {
    return getParticipants(source).find(entry => entry.id === participantId) || null;
}

export function getParticipantMap(source) {
    return new Map(getParticipants(source).map(entry => [entry.id, entry]));
}

export function getControlledParticipants(source, userId = game.user?.id) {
    return getParticipants(source).filter(entry => entry.controllerId === userId);
}

export function getSelfParticipant(source, userId = game.user?.id) {
    return getControlledParticipants(source, userId).find(entry => entry.type === 'user') || null;
}

export function getCurrentControlledParticipant(source, currentParticipantId = null, userId = game.user?.id) {
    const current = currentParticipantId ? getParticipant(source, currentParticipantId) : null;
    if (current?.controllerId === userId) return current;
    return getSelfParticipant(source, userId) || getControlledParticipants(source, userId)[0] || null;
}

export function buildDealerProfileFromParticipant(participant) {
    const entry = normalizeParticipant(participant);
    if (!entry) return null;

    return {
        type: entry.type,
        participantId: entry.id,
        actorId: entry.actorId || null,
        userId: entry.userId || null,
        controllerId: entry.controllerId || null,
        name: entry.name || t('PARLOR.Participant.DealerFallback'),
        avatar: entry.avatar || null,
        ownerName: entry.ownerName || ''
    };
}

export function getParticipantLabel(participant) {
    const entry = normalizeParticipant(participant);
    if (!entry) return t('PARLOR.Participant.UnnamedParticipant');
    if (entry.type === 'user' && entry.ownerName) return `${entry.name} · ${entry.ownerName}`;
    return entry.name;
}

export function getDisplayParticipant(source, participantId, viewerUserId = game.user?.id) {
    const entry = getParticipant(source, participantId);
    if (entry) {
        return {
            kind: entry.type,
            isSelf: entry.type === 'user' && entry.controllerId === viewerUserId,
            name: entry.name,
            ownerName: entry.ownerName,
            avatarHtml: entry.avatar
                ? `<img src="${entry.avatar}" width="44" height="44">`
                : (entry.type === 'bot' ? '🤖' : (entry.type === 'npc' ? '🎭' : '👤'))
        };
    }

    const fallback = String(participantId || '');
    if (isBotParticipantId(fallback)) {
        const actorId = getActorIdFromParticipantId(fallback);
        const actor = actorId ? game.actors?.get(actorId) : null;
        const avatar = actor ? getParticipantAvatar(actor, null) : null;
        return {
            kind: 'bot',
            isSelf: false,
            name: actor?.name || fallback,
            ownerName: actor ? t('PARLOR.Participant.DMOwner') : '',
            avatarHtml: avatar ? `<img src="${avatar}" width="44" height="44">` : '🤖'
        };
    }
    if (isNpcParticipantId(fallback)) {
        return { kind: 'npc', isSelf: false, name: fallback.replace(/^npc:/i, ''), ownerName: t('PARLOR.Participant.DMOwner'), avatarHtml: '🎭' };
    }

    if (isUserParticipantId(fallback)) {
        const userId = fallback.slice(USER_PREFIX.length);
        const user = game.users?.get(userId);
        return {
            kind: 'user',
            isSelf: userId === viewerUserId,
            name: user?.name || fallback,
            ownerName: '',
            avatarHtml: user?.avatar ? `<img src="${user.avatar}" width="44" height="44">` : '👤'
        };
    }

    const user = game.users?.get(fallback);
    if (user) {
        return {
            kind: 'user',
            isSelf: user.id === viewerUserId,
            name: user.name || fallback,
            ownerName: user.name || '',
            avatarHtml: user.avatar ? `<img src="${user.avatar}" width="44" height="44">` : '👤'
        };
    }

    return { kind: 'npc', isSelf: false, name: fallback || t('PARLOR.Participant.Unnamed'), ownerName: '', avatarHtml: '🎭' };
}

export function getParticipantName(source, participantId, viewerUserId = game.user?.id) {
    const entry = getDisplayParticipant(source, participantId, viewerUserId);
    if (entry.isSelf) return t('PARLOR.Participant.You');
    return entry.name || String(participantId || t('PARLOR.Participant.Unnamed'));
}

export function getChipOwnerIdForUser(user) {
    return createUserParticipant(user)?.id || null;
}

export function reviveParticipantFromId(participantId) {
    const id = String(participantId || '');
    if (!id) return null;
    if (isBotParticipantId(id)) {
        const actorId = getActorIdFromParticipantId(id);
        const actor = actorId ? game.actors?.get(actorId) : null;
        if (actor) return createNpcBotParticipant(actor);
        return normalizeParticipant({ id, type: 'bot', name: id, avatar: null, ownerName: '' });
    }

    if (isUserParticipantId(id)) {
        const userId = id.slice(USER_PREFIX.length);
        const user = game.users?.get(userId) || null;
        return user ? createUserParticipant(user) : null;
    }

    const actorId = getActorIdFromParticipantId(id);
    const actor = actorId ? game.actors?.get(actorId) : null;
    if (!actor) return null;

    if (isNpcParticipantId(id)) {
        return createNpcParticipant(actor);
    }

    const user = game.users?.find(entry => entry.character?.id === actor.id) || null;
    if (user) return createUserParticipant(user);

    return normalizeParticipant({
        id,
        type: 'user',
        actorId: actor.id,
        userId: null,
        controllerId: null,
        name: actor.name || id,
        avatar: getParticipantAvatar(actor, null),
        ownerName: ''
    });
}

export function migrateChipOwnerId(rawId) {
    const id = String(rawId || '');
    if (!id) return null;
    if (isPlayerParticipantId(id) || isNpcParticipantId(id) || isBotParticipantId(id)) return id;

    const user = game.users?.get(id);
    const participant = user ? createUserParticipant(user) : null;
    return participant?.id || id;
}

export function getPlayerCharacterParticipants({ includeGM = false, includeInactive = false } = {}) {
    return game.users
        .filter(user => {
            if (!includeGM && user.isGM) return false;
            return includeInactive || user.active;
        })
        .map(createUserParticipant)
        .filter(Boolean);
}
