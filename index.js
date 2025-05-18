// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (基于事件触发, 区分立即与防抖)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中F
// 4. 使用Web Worker优化深拷贝性能
// 5. 利用记忆表格插件自身的导入/导出机制，实现表格的备份与恢复

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    // --- 核心应用函数 ---
    saveSettingsDebounced,
    eventSource,
    event_types,
    selectCharacterById,    // 用于选择角色
    doNewChat,              // 用于创建新聊天
    printMessages,          // 用于刷新聊天UI
    scrollChatToBottom,     // 用于滚动到底部
    updateChatMetadata,     // 用于更新聊天元数据 - Note: Standard ST function, may not work as expected with plugin metadata proxies
    saveChatConditional,    // 用于保存聊天
    saveChat,               // 用于插件强制保存聊天
    characters,             // 需要访问角色列表来查找索引
    getThumbnailUrl,        // 可能需要获取头像URL（虽然备份里应该有）
    // --- 其他可能需要的函数 ---
    // clearChat, // 可能不需要，doNewChat 应该会处理
    // getCharacters, // 切换角色后可能需要更新？selectCharacterById 内部应该会处理
} from '../../../../script.js';

import {
    // --- 群组相关函数 ---
    select_group_chats,     // 用于选择群组聊天
    // getGroupChat, // 可能不需要，select_group_chats 应该会处理
} from '../../../group-chats.js';



// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backup';
const DEFAULT_SETTINGS = {
    maxTotalBackups: 3,        // 整个系统保留的最大备份数量
    backupDebounceDelay: 1500, // 防抖延迟时间 (毫秒)
    debug: true,               // 调试模式
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackup';
const DB_VERSION = 1;
const STORE_NAME = 'backups';

// Web Worker 实例 (稍后初始化)
let backupWorker = null;
// 用于追踪 Worker 请求的 Promise
const workerPromises = {};
let workerRequestId = 0;

// 数据库连接池 - 实现单例模式
let dbConnection = null;

// 备份状态控制
let isBackupInProgress = false; // 并发控制标志
let backupTimeout = null;       // 防抖定时器 ID

// --- 深拷贝逻辑 (将在Worker和主线程中使用) ---
const deepCopyLogicString = `
    const deepCopy = (obj) => {
        try {
            return structuredClone(obj);
        } catch (error) {
            try {
                return JSON.parse(JSON.stringify(obj));
            } catch (jsonError) {
                throw jsonError; // 抛出错误，让主线程知道
            }
        }
    };
`;

// --- 日志函数 ---
function logDebug(...args) {
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        console.log(`[聊天自动备份][${new Date().toLocaleTimeString()}]`, ...args);
    }
}

// --- 设置初始化 ---
function initSettings() {
    console.log('[聊天自动备份] 初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        console.log('[聊天自动备份] 创建新的插件设置');
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }

    // 确保设置结构完整
    const settings = extension_settings[PLUGIN_NAME];

    // 如果之前使用的是旧版设置，则迁移到新版
    if (settings.hasOwnProperty('maxBackupsPerChat') && !settings.hasOwnProperty('maxTotalBackups')) {
        settings.maxTotalBackups = 3; // 默认值
        delete settings.maxBackupsPerChat; // 移除旧设置
        console.log('[聊天自动备份] 从旧版设置迁移到新版设置');
    }

    // 确保所有设置都存在
    settings.maxTotalBackups = settings.maxTotalBackups ?? DEFAULT_SETTINGS.maxTotalBackups;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = settings.debug ?? DEFAULT_SETTINGS.debug;

    // 验证设置合理性
    if (typeof settings.maxTotalBackups !== 'number' || settings.maxTotalBackups < 1) {
        console.log(`[聊天自动备份] 无效的最大备份数 ${settings.maxTotalBackups}，重置为默认值 ${DEFAULT_SETTINGS.maxTotalBackups}`);
        settings.maxTotalBackups = DEFAULT_SETTINGS.maxTotalBackups;
    }

    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300) {
        console.log(`[聊天自动备份] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    console.log('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}

// --- IndexedDB 相关函数 (优化版本) ---
// 初始化 IndexedDB 数据库
function initDatabase() {
    return new Promise((resolve, reject) => {
        logDebug('初始化 IndexedDB 数据库');
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = function(event) {
            console.error('[聊天自动备份] 打开数据库失败:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = function(event) {
            const db = event.target.result;
            logDebug('数据库打开成功');
            resolve(db);
        };

        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.log('[聊天自动备份] 数据库升级中，创建对象存储');
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
                store.createIndex('chatKey', 'chatKey', { unique: false });
                console.log('[聊天自动备份] 创建了备份存储和索引');
            }
        };
    });
}

// 获取数据库连接 (优化版本 - 使用连接池)
async function getDB() {
    try {
        // 检查现有连接是否可用
        if (dbConnection && dbConnection.readyState !== 'closed') {
            return dbConnection;
        }

        // 创建新连接
        dbConnection = await initDatabase();
        return dbConnection;
    } catch (error) {
        console.error('[聊天自动备份] 获取数据库连接失败:', error);
        throw error;
    }
}

// 保存备份到 IndexedDB (优化版本)
async function saveBackupToDB(backup) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');

            transaction.oncomplete = () => {
                logDebug(`备份已保存到IndexedDB, 键: [${backup.chatKey}, ${backup.timestamp}]`);
                resolve();
            };

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 保存备份事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            store.put(backup);
        });
    } catch (error) {
        console.error('[聊天自动备份] saveBackupToDB 失败:', error);
        throw error;
    }
}

// 从 IndexedDB 获取指定聊天的所有备份 (优化版本)
async function getBackupsForChat(chatKey) {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('chatKey');
            const request = index.getAll(chatKey);

            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了 ${backups.length} 个备份，chatKey: ${chatKey}`);
                resolve(backups);
            };

            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getBackupsForChat 失败:', error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 获取所有备份 (优化版本)
async function getAllBackups() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAll();

            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${backups.length} 个备份`);
                resolve(backups);
            };

            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackups 失败:', error);
        return [];
    }
}

// 从 IndexedDB 获取所有备份的主键 (优化清理逻辑)
async function getAllBackupKeys() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            // 使用 getAllKeys() 只获取主键
            const request = store.getAllKeys();

            request.onsuccess = () => {
                // 返回的是键的数组，每个键是 [chatKey, timestamp]
                const keys = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${keys.length} 个备份的主键`);
                resolve(keys);
            };

            request.onerror = (event) => {
                console.error('[聊天自动备份] 获取所有备份键失败:', event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error('[聊天自动备份] getAllBackupKeys 失败:', error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 删除指定备份 (优化版本)
async function deleteBackup(chatKey, timestamp) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');

            transaction.oncomplete = () => {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };

            transaction.onerror = (event) => {
                console.error('[聊天自动备份] 删除备份事务失败:', event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            store.delete([chatKey, timestamp]);
        });
    } catch (error) {
        console.error('[聊天自动备份] deleteBackup 失败:', error);
        throw error;
    }
}

// --- 聊天信息获取 (保持不变) ---
function getCurrentChatKey() {
    const context = getContext();
    // logDebug('获取当前聊天标识符, context:',
    //     {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
    if (context.groupId && context.chatId) { // 确保群组聊天也有chatId
        const key = `group_${context.groupId}_${context.chatId}`;
        // logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined && context.chatId) { // 确保chatId存在
        const key = `char_${context.characterId}_${context.chatId}`;
        // logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    // console.warn('[聊天自动备份] 无法获取当前聊天的有效标识符 (可能未选择角色/群组或聊天)');
    return null;
}

function getCurrentChatInfo() {
    const context = getContext();
    let chatName = '当前聊天', entityName = '未知';

    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        entityName = group ? group.name : `群组 ${context.groupId}`;
        chatName = context.chatId || '新聊天'; // 使用更明确的默认名
        // logDebug('获取到群组聊天信息:', {entityName, chatName});
    } else if (context.characterId !== undefined) {
        entityName = context.name2 || `角色 ${context.characterId}`;
        const character = context.characters?.[context.characterId];
        if (character && context.chatId) {
             // chat文件名可能包含路径，只取最后一部分
             const chatFile = character.chat || context.chatId;
             chatName = chatFile.substring(chatFile.lastIndexOf('/') + 1).replace('.jsonl', '');
        } else {
            chatName = context.chatId || '新聊天';
        }
        // logDebug('获取到角色聊天信息:', {entityName, chatName});
    } else {
        // console.warn('[聊天自动备份] 无法获取聊天实体信息，使用默认值');
    }

    return { entityName, chatName };
}

// --- Web Worker 通信 ---
// 发送数据到 Worker 并返回包含拷贝后数据的 Promise
function performDeepCopyInWorker(chat, metadata) {
    return new Promise((resolve, reject) => {
        if (!backupWorker) {
            return reject(new Error("Backup worker not initialized."));
        }

        const currentRequestId = ++workerRequestId;
        workerPromises[currentRequestId] = { resolve, reject };

        // logDebug(`[主线程] 发送数据到 Worker (ID: ${currentRequestId}), Chat长度: ${chat?.length}`);
        try {
             // 只发送需要拷贝的数据，减少序列化开销
            backupWorker.postMessage({
                id: currentRequestId,
                payload: { chat, metadata }
            });
        } catch (error) {
             console.error(`[主线程] 发送消息到 Worker 失败 (ID: ${currentRequestId}):`, error);
             delete workerPromises[currentRequestId];
             reject(error);
        }
    });
}

// --- 核心备份逻辑封装 (接收具体数据) ---
async function executeBackupLogic_Core(chat, chat_metadata_to_backup, settings) {
    const currentTimestamp = Date.now();
    logDebug(`(封装) 开始执行核心备份逻辑 @ ${new Date(currentTimestamp).toLocaleTimeString()}`);

    // 1. 前置检查 (使用传入的数据，而不是 getContext())
    const chatKey = getCurrentChatKey(); // 这个仍然需要获取当前的chatKey
    if (!chatKey) {
        console.warn('[聊天自动备份] (封装) 无有效的聊天标识符');
        return false;
    }

    const { entityName, chatName } = getCurrentChatInfo();
    const lastMsgIndex = chat.length - 1;
    const lastMessage = chat[lastMsgIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '(空消息)';

    // logDebug(`(封装) 准备备份聊天: ${entityName} - ${chatName}, 消息数: ${chat.length}, 最后消息ID: ${lastMsgIndex}`);
    // logDebug(`(封装) 备份的 metadata 状态:`, chat_metadata_to_backup);

    try {
        // 2. 使用 Worker 进行深拷贝 (使用传入的 chat 和 chat_metadata_to_backup)
        let copiedChat, copiedMetadata;
        if (backupWorker) {
            try {
                // console.time('[聊天自动备份] Web Worker 深拷贝时间');
                // logDebug('(封装) 请求 Worker 执行深拷贝...');
                const result = await performDeepCopyInWorker(chat, chat_metadata_to_backup); // 使用传入的数据
                copiedChat = result.chat;
                copiedMetadata = result.metadata;
                // console.timeEnd('[聊天自动备份] Web Worker 深拷贝时间');
                // logDebug('(封装) 从 Worker 收到拷贝后的数据');
            } catch(workerError) {
                 console.error('[聊天自动备份] (封装) Worker 深拷贝失败，将尝试在主线程执行:', workerError);
                  // console.time('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
                  try {
                      copiedChat = structuredClone(chat);
                      copiedMetadata = structuredClone(chat_metadata_to_backup); // 使用传入的数据
                  } catch (structuredCloneError) {
                     try {
                         copiedChat = JSON.parse(JSON.stringify(chat));
                         copiedMetadata = JSON.parse(JSON.stringify(chat_metadata_to_backup)); // 使用传入的数据
                     } catch (jsonError) {
                         console.error('[聊天自动备份] (封装) 主线程深拷贝也失败:', jsonError);
                         throw new Error("无法完成聊天数据的深拷贝");
                     }
                  }
                  // console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
            }
        } else {
            // Worker 不可用，直接在主线程执行 (使用传入的 chat 和 chat_metadata_to_backup)
            // console.time('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
             try {
                 copiedChat = structuredClone(chat);
                 copiedMetadata = structuredClone(chat_metadata_to_backup); // 使用传入的数据
             } catch (structuredCloneError) {
                try {
                    copiedChat = JSON.parse(JSON.stringify(chat));
                    copiedMetadata = JSON.parse(JSON.stringify(chat_metadata_to_backup)); // 使用传入的数据
                } catch (jsonError) {
                    console.error('[聊天自动备份] (封装) 主线程深拷贝失败:', jsonError);
                    throw new Error("无法完成聊天数据的深拷贝");
                }
             }
            // console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
        }

        if (!copiedChat) {
             throw new Error("未能获取有效的聊天数据副本");
        }

        // 3. 构建备份对象
        const backup = {
            timestamp: currentTimestamp,
            chatKey,
            entityName,
            chatName,
            lastMessageId: lastMsgIndex,
            lastMessagePreview,
            chat: copiedChat,
            metadata: copiedMetadata || {} // 确保 metadata 总是对象
        };

        // 4. 检查当前聊天是否已有基于最后消息ID的备份 (避免完全相同的备份)
        const existingBackups = await getBackupsForChat(chatKey); // 获取当前聊天的备份

        // 5. 检查重复并处理 (基于 lastMessageId)
        const existingBackupIndex = existingBackups.findIndex(b => b.lastMessageId === lastMsgIndex);
        let needsSave = true;

        if (existingBackupIndex !== -1) {
            const existingTimestamp = existingBackups[existingBackupIndex].timestamp;
            if (backup.timestamp > existingTimestamp) {
                // logDebug(`(封装) 发现具有相同最后消息ID (${lastMsgIndex}) 的旧备份 (时间戳 ${existingTimestamp})，将删除旧备份以便保存新备份 (时间戳 ${backup.timestamp})`);
                await deleteBackup(chatKey, existingTimestamp);
            } else {
                // logDebug(`(封装) 发现具有相同最后消息ID (${lastMsgIndex}) 且时间戳更新或相同的备份 (时间戳 ${existingTimestamp} vs ${backup.timestamp})，跳过本次保存`);
                needsSave = false;
            }
        }

        if (!needsSave) {
            // logDebug('(封装) 备份已存在或无需更新 (基于lastMessageId和时间戳比较)，跳过保存和全局清理步骤');
            return false;
        }

        await saveBackupToDB(backup);
        // logDebug(`(封装) 新备份已保存: [${chatKey}, ${backup.timestamp}]`);

        const allBackupKeys = await getAllBackupKeys();
        if (allBackupKeys.length > settings.maxTotalBackups) {
            // logDebug(`(封装) 总备份数 (${allBackupKeys.length}) 超出系统限制 (${settings.maxTotalBackups})`);
            allBackupKeys.sort((a, b) => a[1] - b[1]);
            const numToDelete = allBackupKeys.length - settings.maxTotalBackups;
            const keysToDelete = allBackupKeys.slice(0, numToDelete);
            // logDebug(`(封装) 准备删除 ${keysToDelete.length} 个最旧的备份 (基于键)`);
            await Promise.all(keysToDelete.map(key => {
                // logDebug(`(封装) 删除旧备份 (基于键): chatKey=${key[0]}, timestamp=${new Date(key[1]).toLocaleString()}`);
                return deleteBackup(key[0], key[1]);
            }));
            // logDebug(`(封装) ${keysToDelete.length} 个旧备份已删除`);
        } else {
            // logDebug(`(封装) 总备份数 (${allBackupKeys.length}) 未超出限制 (${settings.maxTotalBackups})，无需清理`);
        }
        // logDebug(`(封装) 成功完成聊天备份及可能的清理: ${entityName} - ${chatName}`);
        return true;
    } catch (error) {
        console.error('[聊天自动备份] (封装) 备份或清理过程中发生严重错误:', error);
        throw error;
    }
}

// --- 条件备份函数 (类似 saveChatConditional) ---
async function performBackupConditional() {
    if (isBackupInProgress) {
        // logDebug('备份已在进行中，跳过本次请求');
        return;
    }
    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error('[聊天自动备份] 无法获取当前设置，取消备份');
        return;
    }
    // logDebug('执行条件备份 (performBackupConditional)');
    clearTimeout(backupTimeout); backupTimeout = null;
    try {
        // logDebug('尝试调用 saveChatConditional() 以刷新元数据...');
        await saveChatConditional(); // 确保元数据已保存到主上下文
        await new Promise(resolve => setTimeout(resolve, 150)); // 短暂延迟让元数据同步
        // logDebug('saveChatConditional() 调用完成，继续获取上下文');
    } catch (e) {
        console.warn('[聊天自动备份] 调用 saveChatConditional 时发生错误 (可能无害):', e);
    }

    const context = getContext();
    const chatKey = getCurrentChatKey(); // 重新获取，确保是最新的
    if (!chatKey) {
        // logDebug('无法获取有效的聊天标识符 (在 saveChatConditional 后)，取消备份');
        return false;
    }
    if (!context.chatMetadata) {
        // console.warn('[聊天自动备份] chatMetadata 无效 (在 saveChatConditional 后)，取消备份');
        return false;
    }
    if (!context.chatMetadata.sheets || context.chatMetadata.sheets.length === 0) {
        // console.warn('[聊天自动备份] chatMetadata.sheets 无效或为空 (在 saveChatConditional 后)，取消备份');
        return false;
    }

    isBackupInProgress = true;
    // logDebug('设置备份锁');
    try {
        const { chat } = context;
        const chat_metadata_to_backup = context.chatMetadata;
        const success = await executeBackupLogic_Core(chat, chat_metadata_to_backup, currentSettings);
        if (success) {
            await updateBackupsList();
        }
        return success;
    } catch (error) {
        console.error('[聊天自动备份] 条件备份执行失败:', error);
        toastr.error(`备份失败: ${error.message || '未知错误'}`, '聊天自动备份');
        return false;
    } finally {
        isBackupInProgress = false;
        // logDebug('释放备份锁');
    }
}

// --- 防抖备份函数 (类似 saveChatDebounced) ---
function performBackupDebounced() {
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        // logDebug('无法获取计划防抖备份时的 ChatKey，取消');
        clearTimeout(backupTimeout); backupTimeout = null;
        return;
    }
    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error('[聊天自动备份] 无法获取有效的防抖延迟设置，取消防抖');
        clearTimeout(backupTimeout); backupTimeout = null;
        return;
    }
    const delay = currentSettings.backupDebounceDelay;
    // logDebug(`计划执行防抖备份 (延迟 ${delay}ms), 针对 ChatKey: ${scheduledChatKey}`);
    clearTimeout(backupTimeout);
    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey();
        if (currentChatKey !== scheduledChatKey) {
            // logDebug(`上下文已更改 (当前: ${currentChatKey}, 计划时: ${scheduledChatKey})，取消此防抖备份`);
            backupTimeout = null;
            return;
        }
        // logDebug(`执行延迟的备份操作 (来自防抖), ChatKey: ${currentChatKey}`);
        await performBackupConditional();
        backupTimeout = null;
    }, delay);
}

// --- 手动备份 ---
async function performManualBackup() {
    console.log('[聊天自动备份] 执行手动备份 (调用条件函数)');
    await performBackupConditional(); // 手动备份也走条件检查和锁逻辑
    toastr.success('已手动备份当前聊天', '聊天自动备份');
}

// --- 恢复逻辑 (核心修改) ---
async function restoreBackup(backupData) {
    logDebug('[聊天自动备份] 开始恢复备份 (新流程):', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });

    // 1. 从备份数据中获取聊天和元数据
    const retrievedChatMetadata = backupData.metadata;
    const retrievedChat = backupData.chat;

    if (!retrievedChatMetadata || !retrievedChat) {
        toastr.error('备份数据无效，无法恢复。');
        console.error('[聊天自动备份] 恢复失败：备份数据中的 chat 或 metadata 为空。');
        return false;
    }

    // 2. 构建 .jsonl 格式的字符串
    let jsonlString = "";
    try {
        jsonlString = JSON.stringify(retrievedChatMetadata) + '\n';
        retrievedChat.forEach(message => {
            jsonlString += JSON.stringify(message) + '\n';
        });
    } catch (stringifyError) {
        toastr.error('构建恢复数据时出错，无法恢复。');
        console.error('[聊天自动备份] 恢复失败：序列化备份数据为JSONL时出错:', stringifyError);
        return false;
    }

    // 3. 将 .jsonl 字符串转换为 File 对象
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    // 清理文件名，移除可能导致问题的字符
    const safeEntityName = (backupData.entityName || 'UnknownEntity').replace(/[^a-zA-Z0-9_-]/g, '_');
    const restoredFilename = `${safeEntityName}_restored_${timestamp}.jsonl`;
    const chatFileObject = new File([jsonlString], restoredFilename, { type: "application/json-lines" }); // 使用标准MIME类型
    logDebug(`[聊天自动备份] 已构建 File 对象: ${chatFileObject.name}, 大小: ${chatFileObject.size} bytes`);

    // 4. 准备 FormData 并确定导入API的URL
    const currentContext = getContext(); // 获取当前选中的角色/群组作为导入目标
    const formData = new FormData();
    formData.append('file', chatFileObject); // 'file' 是 /api/chats/group/import 和 /api/characters/import (角色卡) 通常期望的字段名
    formData.append('file_type', 'jsonl');   // 明确文件类型

    let success = false;
    let newChatNameForLoad = ''; // 用于后续 openCharacterChat 或 select_group_chats

    // 5. (可选但推荐) 保存当前聊天
    try {
        logDebug('[聊天自动备份] 尝试保存当前聊天 (如有未保存的更改)...');
        await saveChatConditional();
        logDebug('[聊天自动备份] 当前聊天已尝试保存。');
    } catch (saveCurrentError) {
        console.warn('[聊天自动备份] 保存当前聊天时出错 (可能无害):', saveCurrentError);
    }

    // 6. 根据是角色还是群组，执行不同的恢复逻辑
    const isRestoringToGroup = backupData.chatKey.startsWith('group_');
    logDebug(`[聊天自动备份] 备份类型判断: isRestoringToGroup = ${isRestoringToGroup}`);

    if (isRestoringToGroup) { // 恢复到群组
        if (currentContext.selected_group === undefined) {
            toastr.error('请先选择一个群组作为恢复目标，或确保备份是针对群组的。');
            console.error('[聊天自动备份] 恢复群组聊天失败：未选择目标群组。');
            return false;
        }
        const targetGroupId = currentContext.selected_group;
        formData.append('group_id', targetGroupId); // 导入到当前选中的群组
        logDebug(`[聊天自动备份] 准备将备份导入到群组: ${targetGroupId}`);
        const importUrl = '/api/chats/group/import';

        try {
            const response = await fetch(importUrl, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: formData,
            });
            if (!response.ok) {
                const errorText = await response.text();
                const errorData = (() => { try { return JSON.parse(errorText); } catch { return { error: errorText }; } })();
                throw new Error(`群组导入API失败: ${response.status} - ${errorData.error || '未知错误'}`);
            }
            const importResult = await response.json();
            logDebug(`[聊天自动备份] 群组导入API响应:`, importResult);

            if (importResult.res) { // importResult.res 是新创建的聊天ID (文件名)
                newChatNameForLoad = importResult.res;
                logDebug(`[聊天自动备份] 群组聊天导入成功，新聊天ID: ${newChatNameForLoad}。尝试加载...`);
                await select_group_chats(targetGroupId, newChatNameForLoad);
                const groupName = groups.find(g=>g.id === targetGroupId)?.name || targetGroupId;
                toastr.success(`群组聊天 "${newChatNameForLoad}" 已恢复并加载到群组 "${groupName}"！`);
                success = true;
            } else {
                throw new Error('群组导入API未返回预期的聊天ID。');
            }
        } catch (error) {
            console.error(`[聊天自动备份] 通过群组导入API恢复时出错:`, error);
            toastr.error(`恢复群组聊天失败: ${error.message}`);
        }

    } else { // 恢复到角色
        if (currentContext.characterId === undefined) {
            toastr.error('请先选择一个角色作为恢复目标，或确保备份是针对角色的。');
            console.error('[聊天自动备份] 恢复角色聊天失败：未选择目标角色。');
            return false;
        }
        const character = characters[currentContext.characterId];
        newChatNameForLoad = chatFileObject.name.replace('.jsonl', ''); // 使用我们生成的File对象的文件名
        const chatToSaveForRole = [retrievedChatMetadata, ...retrievedChat]; // 构建符合 /api/chats/save 的数据

        logDebug(`[聊天自动备份] 准备将备份保存为角色 "${character.name}" 的新聊天: ${newChatNameForLoad}`);
        try {
            const saveResponse = await fetch('/api/chats/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: character.name,
                    file_name: newChatNameForLoad, // 这是新聊天文件的名称
                    chat: chatToSaveForRole,       // 包含元数据和消息的数组
                    avatar_url: character.avatar,  // 当前角色的头像
                    force: true                    // 强制保存，如果需要覆盖同名文件（理论上我们的文件名是唯一的）
                }),
            });
            if (!saveResponse.ok) {
                const errorText = await saveResponse.text();
                const errorData = (() => { try { return JSON.parse(errorText); } catch { return { error: errorText }; } })();
                throw new Error(`角色聊天保存API失败: ${saveResponse.status} - ${errorData.error || '未知错误'}`);
            }
            logDebug(`[聊天自动备份] 角色聊天文件 "${newChatNameForLoad}.jsonl" 已通过API保存。`);

            logDebug(`[聊天自动备份] 尝试打开新保存的角色聊天: ${newChatNameForLoad}`);
            await openCharacterChat(newChatNameForLoad); // 使用不带 .jsonl 后缀的文件名
            toastr.success(`角色聊天 "${newChatNameForLoad}" 已恢复并加载！`);
            success = true;
        } catch (error) {
            console.error(`[聊天自动备份] 保存或打开恢复的角色聊天时出错:`, error);
            toastr.error(`恢复角色聊天失败: ${error.message}`);
        }
    }

    if (success) {
        logDebug('[聊天自动备份] 恢复流程完成。');
        // SillyTavern 核心在 openCharacterChat 和 select_group_chats 内部应该已经处理了 CHAT_CHANGED 事件
        // eventSource.emit(event_types.CHAT_CHANGED, newChatNameForLoad); // 可能不需要显式触发
        await updateBackupsList(); // 刷新备份列表UI，显示新的聊天（如果适用）或更新状态
    }
    return success;
}


// --- UI 更新 ---
async function updateBackupsList() {
    // console.log('[聊天自动备份] 开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        // console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
        return;
    }

    backupsContainer.html('<div class="backup_empty_notice">正在加载备份...</div>');

    try {
        const allBackups = await getAllBackups();
        backupsContainer.empty(); // 清空

        if (allBackups.length === 0) {
            backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
            return;
        }

        // 按时间降序排序
        allBackups.sort((a, b) => b.timestamp - a.timestamp);
        // logDebug(`渲染 ${allBackups.length} 个备份`);

        allBackups.forEach(backup => {
            const date = new Date(backup.timestamp);
            const formattedDate = date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

            const backupItem = $(`
                <div class="backup_item">
                    <div class="backup_info">
                        <div class="backup_header">
                            <span class="backup_entity" title="${backup.entityName}">${backup.entityName || '未知实体'}</span>
                            <span class="backup_chat" title="${backup.chatName}">${backup.chatName || '未知聊天'}</span>
                        </div>
                         <div class="backup_details">
                            <span class="backup_mesid">消息数: ${backup.lastMessageId + 1}</span>
                            <span class="backup_date">${formattedDate}</span>
                        </div>
                        <div class="backup_preview" title="${backup.lastMessagePreview}">${backup.lastMessagePreview}...</div>
                    </div>
                    <div class="backup_actions">
                        <button class="menu_button backup_preview_btn" title="预览此备份的最后两条消息" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">预览</button>
                        <button class="menu_button backup_restore" title="恢复此备份到当前选中的角色/群组" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">删除</button>
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        // console.log('[聊天自动备份] 备份列表渲染完成');
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

// --- 初始化与事件绑定 ---
jQuery(async () => {
    console.log('[聊天自动备份] 插件加载中...');

    // 初始化设置
    const settings = initSettings();

    try {
        // 初始化数据库
        await initDatabase();

        // --- 创建 Web Worker ---
        try {
            const workerCode = `
                ${deepCopyLogicString} // 注入深拷贝函数

                self.onmessage = function(e) {
                    const { id, payload } = e.data;
                    if (!payload) {
                         self.postMessage({ id, error: 'Invalid payload received by worker' });
                         return;
                    }
                    try {
                        const copiedChat = payload.chat ? deepCopy(payload.chat) : null;
                        const copiedMetadata = payload.metadata ? deepCopy(payload.metadata) : null;
                        self.postMessage({ id, result: { chat: copiedChat, metadata: copiedMetadata } });
                    } catch (error) {
                        self.postMessage({ id, error: error.message || 'Worker deep copy failed' });
                    }
                };
            `;
            const blob = new Blob([workerCode], { type: 'application/javascript' });
            backupWorker = new Worker(URL.createObjectURL(blob));
            // console.log('[聊天自动备份] Web Worker 已创建');

            backupWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                if (workerPromises[id]) {
                    if (error) {
                        // console.error(`[主线程] Worker 返回错误 (ID: ${id}):`, error);
                        workerPromises[id].reject(new Error(error));
                    } else {
                        // logDebug(`[主线程] Worker 返回结果 (ID: ${id})`);
                        workerPromises[id].resolve(result);
                    }
                    delete workerPromises[id];
                } else {
                     // console.warn(`[主线程] 收到未知或已处理的 Worker 消息 (ID: ${id})`);
                }
            };

            backupWorker.onerror = function(error) {
                console.error('[聊天自动备份] Web Worker 发生错误:', error);
                 Object.keys(workerPromises).forEach(id => {
                     workerPromises[id].reject(new Error('Worker encountered an unrecoverable error.'));
                     delete workerPromises[id];
                 });
                toastr.error('备份 Worker 发生错误，自动备份可能已停止', '聊天自动备份');
            };

        } catch (workerError) {
            console.error('[聊天自动备份] 创建 Web Worker 失败:', workerError);
            backupWorker = null;
            toastr.error('无法创建备份 Worker，将回退到主线程备份（性能较低）', '聊天自动备份');
        }

        // 加载插件UI
        const settingsHtml = await renderExtensionTemplateAsync(
            `third-party/${PLUGIN_NAME}`,
            'settings'
        );
        $('#extensions_settings').append(settingsHtml);
        // console.log('[聊天自动备份] 已添加设置界面');

        // 设置控制项
        const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
        $settingsBlock.html(`
            <div style="margin-bottom: 8px;">
                <label style="display: inline-block; min-width: 120px;">防抖延迟 (ms):</label>
                <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}"
                    min="300" max="10000" step="100" title="编辑或删除消息后，等待多少毫秒再执行备份 (建议 1000-1500)"
                    style="width: 80px;" />
            </div>
            <div>
                <label style="display: inline-block; min-width: 120px;">系统最大备份数:</label>
                <input type="number" id="chat_backup_max_total" value="${settings.maxTotalBackups}"
                    min="1" max="10" step="1" title="系统中保留的最大备份数量"
                    style="width: 80px;" />
            </div>
        `);
        $('.chat_backup_controls').prepend($settingsBlock);

        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 10) {
                settings.maxTotalBackups = total;
                // logDebug(`系统最大备份数已更新为: ${total}`);
                saveSettingsDebounced();
            } else {
                // logDebug(`无效的系统最大备份数输入: ${$(this).val()}`);
                $(this).val(settings.maxTotalBackups);
            }
        });
        $(document).on('click', '#chat_backup_manual_backup', performManualBackup);
        $(document).on('input', '#chat_backup_debounce_delay', function() {
            const delay = parseInt($(this).val(), 10);
            if (!isNaN(delay) && delay >= 300 && delay <= 10000) {
                settings.backupDebounceDelay = delay;
                // logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                // logDebug(`无效的防抖延迟输入: ${$(this).val()}`);
                $(this).val(settings.backupDebounceDelay);
            }
        });
        $(document).on('click', '.backup_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            // logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);
            button.prop('disabled', true).text('恢复中...');
            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    transaction.onerror = (event) => reject(event.target.error);
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = (event) => reject(event.target.error);
                });
                if (backup) {
                    if (confirm(`确定要将备份 "${backup.entityName} - ${backup.chatName}" 恢复到当前选中的角色/群组吗？\n\n这将创建一个【新的聊天记录】来承载备份内容。\n\n当前聊天内容不会丢失（会尝试保存），但建议手动保存重要更改。`)) {
                        await restoreBackup(backup); // 调用新的恢复逻辑
                    }
                } else {
                    toastr.error('找不到指定的备份');
                }
            } catch (error) {
                toastr.error(`恢复过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('恢复');
            }
        });
        $(document).on('click', '.backup_delete', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            // logDebug(`点击删除按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);
            const backupItem = button.closest('.backup_item');
            const entityName = backupItem.find('.backup_entity').text();
            const chatName = backupItem.find('.backup_chat').text();
            const date = backupItem.find('.backup_date').text();
            if (confirm(`确定要永久删除这个备份吗？\n\n实体: ${entityName}\n聊天: ${chatName}\n时间: ${date}\n\n此操作无法撤销！`)) {
                button.prop('disabled', true).text('删除中...');
                try {
                    await deleteBackup(chatKey, timestamp);
                    toastr.success('备份已删除');
                    backupItem.fadeOut(300, function() { $(this).remove(); if ($('#chat_backup_list .backup_item').length === 0) updateBackupsList(); });
                } catch (error) {
                    toastr.error(`删除备份失败: ${error.message}`);
                    button.prop('disabled', false).text('删除');
                }
            }
        });
        $(document).on('click', '.backup_preview_btn', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            // logDebug(`点击预览按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);
            button.prop('disabled', true).text('加载中...');
            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    transaction.onerror = (event) => reject(event.target.error);
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = (event) => reject(event.target.error);
                });
                if (backup && backup.chat && backup.chat.length > 0) {
                    const chat = backup.chat;
                    const lastMessages = chat.slice(-2);
                    const processMessage = (messageText) => {
                        if (!messageText) return '(空消息)';
                        let processed = messageText.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
                        processed = processed.replace(/```[\s\S]*?```/g, '').replace(/`[\s\S]*?`/g, '');
                        processed = processed.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/\n\n+/g, '\n').replace(/\n/g, '<br>');
                        return processed;
                    };
                    const style = document.createElement('style');
                    style.textContent = `.message_box{padding:10px;margin-bottom:10px;border-radius:8px;background:rgba(0,0,0,0.15);}.message_sender{font-weight:bold;margin-bottom:5px;color:var(--SmColor);}.message_content{white-space:pre-wrap;line-height:1.4;}.message_content br+br{margin-top:0.5em;}`;
                    const previewContent = document.createElement('div');
                    previewContent.appendChild(style);
                    const headerDiv = document.createElement('h3');
                    headerDiv.textContent = `${backup.entityName} - ${backup.chatName} 预览`;
                    previewContent.appendChild(headerDiv);
                    lastMessages.forEach(msg => {
                        const messageBox = document.createElement('div'); messageBox.className = 'message_box';
                        const senderDiv = document.createElement('div'); senderDiv.className = 'message_sender'; senderDiv.textContent = msg.name || '未知';
                        const contentDiv = document.createElement('div'); contentDiv.className = 'message_content'; contentDiv.innerHTML = processMessage(msg.mes);
                        messageBox.appendChild(senderDiv); messageBox.appendChild(contentDiv); previewContent.appendChild(messageBox);
                    });
                    const footerDiv = document.createElement('div');
                    footerDiv.style.cssText = 'margin-top:10px;opacity:0.7;font-size:0.9em;';
                    footerDiv.textContent = `显示最后 ${lastMessages.length} 条消息，共 ${chat.length} 条`;
                    previewContent.appendChild(footerDiv);
                    const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js'); // 确保导入
                    await callGenericPopup(previewContent, POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true, leftAlign: true, okButton: '关闭' });
                } else {
                    toastr.error('找不到指定的备份或备份为空');
                }
            } catch (error) {
                toastr.error(`预览过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('预览');
            }
        });
        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            // console.log('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });
        setTimeout(async () => {
            $('#chat_backup_debug_toggle').prop('checked', settings.debug);
            $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
            $('#chat_backup_max_total').val(settings.maxTotalBackups);
            await updateBackupsList();
        }, 300);

        function setupBackupEvents() {
            const immediateBackupEvents = [
                event_types.MESSAGE_SENT,
                event_types.GENERATION_ENDED,
                event_types.CHARACTER_FIRST_MESSAGE_SELECTED,
            ].filter(Boolean);
            const debouncedBackupEvents = [
                event_types.MESSAGE_EDITED,
                event_types.MESSAGE_DELETED,
                event_types.MESSAGE_SWIPED,
                event_types.IMAGE_SWIPED,
                event_types.MESSAGE_FILE_EMBEDDED,
                event_types.MESSAGE_REASONING_EDITED,
                event_types.MESSAGE_REASONING_DELETED,
                event_types.FILE_ATTACHMENT_DELETED,
                event_types.GROUP_UPDATED,
            ].filter(Boolean);
            // console.log('[聊天自动备份] 设置立即备份事件监听:', immediateBackupEvents);
            immediateBackupEvents.forEach(eventType => {
                if (!eventType) return;
                eventSource.on(eventType, () => {
                    // logDebug(`事件触发 (立即备份): ${eventType}`);
                    performBackupConditional().catch(error => {
                        console.error(`[聊天自动备份] 立即备份事件 ${eventType} 处理失败:`, error);
                    });
                });
            });
            // console.log('[聊天自动备份] 设置防抖备份事件监听:', debouncedBackupEvents);
            debouncedBackupEvents.forEach(eventType => {
                if (!eventType) return;
                eventSource.on(eventType, () => {
                    // logDebug(`事件触发 (防抖备份): ${eventType}`);
                    performBackupDebounced();
                });
            });
            // console.log('[聊天自动备份] 事件监听器设置完成');
        }
        setupBackupEvents();
        $(document).on('click', '#extensionsMenuButton', () => {
            if ($('#chat_auto_backup_settings').is(':visible')) {
                // console.log('[聊天自动备份] 扩展菜单按钮点击，且本插件设置可见，刷新备份列表');
                setTimeout(updateBackupsList, 200);
            }
        });
        $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
            if (!$(this).closest('.inline-drawer').hasClass('open')) {
                // console.log('[聊天自动备份] 插件设置抽屉打开，刷新备份列表');
                setTimeout(updateBackupsList, 50);
            }
        });
        setTimeout(async () => {
            // logDebug('[聊天自动备份] 执行初始备份检查');
            const context = getContext();
            if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                // logDebug('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                try {
                    await performBackupConditional();
                } catch (error) {
                    console.error('[聊天自动备份] 初始备份执行失败:', error);
                }
            } else {
                // logDebug('[聊天自动备份] 当前没有聊天记录或备份进行中，跳过初始备份');
            }
        }, 4000);
        console.log('[聊天自动备份] 插件加载完成');
    } catch (error) {
        console.error('[聊天自动备份] 插件加载过程中发生严重错误:', error);
        $('#extensions_settings').append(
            '<div class="error">聊天自动备份插件加载失败，请检查控制台。</div>'
        );
    }
});
