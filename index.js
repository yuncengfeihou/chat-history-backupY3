// Chat Auto Backup 插件 - 自动保存和恢复最近三次聊天记录
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (基于事件触发, 区分立即与防抖)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录恢复到新的聊天中F
// 4. 使用Web Worker优化深拷贝性能

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
    updateChatMetadata,     // 用于更新聊天元数据
    saveChatConditional,    // 用于保存聊天
    saveChat,               // 用于插件强制保存聊天
    characters,             // 需要访问角色列表来查找索引
    getThumbnailUrl,        // 可能需要获取头像URL
    getRequestHeaders,      // 用于API请求的头部
    openCharacterChat,      // 用于打开角色聊天
} from '../../../../script.js';

import {
    // --- 群组相关函数 ---
    select_group_chats,     // 用于选择群组聊天
} from '../../../group-chats.js';

// --- 新增：用于API交互的辅助函数 ---

/**
 * 获取指定角色聊天文件的完整内容 (元数据 + 消息数组)
 * @param {string} characterName - 角色名称
 * @param {string} chatFileName - 聊天文件名 (不带 .jsonl)
 * @param {string} avatarFileName - 角色头像文件名
 * @returns {Promise<Array|null>} 返回包含元数据和消息的数组，或在失败时返回null
 */
async function fetchCharacterChatContent(characterName, chatFileName, avatarFileName) {
    logDebug(`[API] 正在获取角色 "${characterName}" 的聊天文件 "${chatFileName}.jsonl" 内容...`);
    try {
        const response = await fetch('/api/chats/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                ch_name: characterName,
                file_name: chatFileName,
                avatar_url: avatarFileName,
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`获取角色聊天内容API失败: ${response.status} - ${errorText}`);
        }
        const chatContentArray = await response.json(); // 应该返回 [metadata, ...messages]
        logDebug(`[API] 成功获取角色 "${characterName}" 的聊天文件内容，总条目数: ${chatContentArray.length}`);
        return chatContentArray;
    } catch (error) {
        console.error(`[API] fetchCharacterChatContent 错误:`, error);
        return null;
    }
}

/**
 * 获取指定群组聊天文件的消息内容 (消息数组)
 * 注意：此API通常只返回消息，元数据需从群组对象获取
 * @param {string} groupId - 群组ID
 * @param {string} groupChatId - 群组聊天ID (文件名，不带 .jsonl)
 * @returns {Promise<Array|null>} 返回消息数组，或在失败时返回null
 */
async function fetchGroupChatMessages(groupId, groupChatId) {
    logDebug(`[API] 正在获取群组 "${groupId}" 的聊天 "${groupChatId}.jsonl" 消息内容...`);
    try {
        const response = await fetch('/api/chats/group/get', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                id: groupId, 
                chat_id: groupChatId
            }),
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`获取群组聊天消息API失败: ${response.status} - ${errorText}`);
        }
        const messagesArray = await response.json();
        logDebug(`[API] 成功获取群组 "${groupId}" 的聊天 "${groupChatId}.jsonl" 消息，消息数: ${messagesArray.length}`);
        return messagesArray;
    } catch (error) {
        console.error(`[API] fetchGroupChatMessages 错误:`, error);
        return null;
    }
}

/**
 * 将聊天元数据和消息数组构造成 .jsonl 格式的字符串
 * @param {object} metadata - 聊天元数据对象
 * @param {Array} messages - 聊天消息对象数组
 * @returns {string} .jsonl 格式的字符串
 */
function constructJsonlString(metadata, messages) {
    if (!metadata || !Array.isArray(messages)) {
        console.error('[CONSTRUCT] 无效的元数据或消息数组传入 constructJsonlString');
        return '';
    }
    let jsonlString = JSON.stringify(metadata) + '\n';
    messages.forEach(message => {
        jsonlString += JSON.stringify(message) + '\n';
    });
    return jsonlString;
}

// 扩展名和设置初始化
const PLUGIN_NAME = 'chat-history-backupY3';
const DEFAULT_SETTINGS = {
    maxTotalBackups: 10, // 整个系统保留的最大备份数量 (增加默认值，避免频繁清理)
    backupDebounceDelay: 1500, // 防抖延迟时间 (毫秒) (增加默认值，更稳定)
    debug: true, // 调试模式
};

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackupY3';
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
            // structuredClone is the most robust way to deep copy in modern JS
            return structuredClone(obj);
        } catch (error) {
            // Fallback to JSON methods if structuredClone fails
            try {
                return JSON.parse(JSON.stringify(obj));
            } catch (jsonError) {
                console.error("Deep copy failed using JSON methods:", jsonError);
                throw new Error("Failed to deep copy object using JSON serialization.");
            }
        }
    };

    // Worker message handler
    self.onmessage = function(e) {
        const { id, payload } = e.data;
        if (!payload) {
             self.postMessage({ id, error: 'Invalid payload received by worker' });
             return;
        }
        try {
            // Perform deep copy on the payload
            const copiedPayload = deepCopy(payload);
            // Send the copied payload back
            self.postMessage({ id, result: copiedPayload });
        } catch (error) {
            console.error('[Worker] Error during deep copy for ID:', id, error);
            self.postMessage({ id, error: error.message || 'Worker deep copy failed' });
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

    const settings = extension_settings[PLUGIN_NAME];

    // Ensure all settings exist and have default values if missing
    settings.maxTotalBackups = settings.maxTotalBackups ?? DEFAULT_SETTINGS.maxTotalBackups;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = settings.debug ?? DEFAULT_SETTINGS.debug;

    // Validate settings sanity
    // Max backups should be at least 1
    if (typeof settings.maxTotalBackups !== 'number' || settings.maxTotalBackups < 1 || settings.maxTotalBackups > 50) { // Cap max backups at 50 for sanity
        console.warn(`[聊天自动备份] 无效的最大备份数 ${settings.maxTotalBackups}，重置为默认值 ${DEFAULT_SETTINGS.maxTotalBackups}`);
        settings.maxTotalBackups = DEFAULT_SETTINGS.maxTotalBackups;
    }

    // Debounce delay should be reasonable
    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300 || settings.backupDebounceDelay > 30000) { // Cap delay at 30s
        console.warn(`[聊天自动备份] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    console.log('[聊天自动备份] 插件设置初始化完成:', settings);
    return settings;
}

// --- IndexedDB 相关函数 ---
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

// 从 IndexedDB 获取指定聊天的所有备份
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

// 从 IndexedDB 获取所有备份
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

// 从 IndexedDB 删除指定备份
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

// --- 聊天信息获取 ---
function getCurrentChatKey() {
    const context = getContext();
    logDebug('获取当前聊天标识符, context:',
        {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId});
    if (context.groupId) {
        const key = `group_${context.groupId}_${context.chatId}`;
        logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined && context.chatId) { // 确保chatId存在
        const key = `char_${context.characterId}_${context.chatId}`;
        logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    console.warn('[聊天自动备份] 无法获取当前聊天的有效标识符 (可能未选择角色/群组或聊天)');
    return null;
}

function getCurrentChatInfo() {
    const context = getContext();
    let chatName = '当前聊天', entityName = '未知';

    if (context.groupId) {
        const group = context.groups?.find(g => g.id === context.groupId);
        entityName = group ? group.name : `群组 ${context.groupId}`;
        chatName = context.chatId || '新聊天'; // 使用更明确的默认名
        logDebug('获取到群组聊天信息:', {entityName, chatName});
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
        logDebug('获取到角色聊天信息:', {entityName, chatName});
    } else {
        console.warn('[聊天自动备份] 无法获取聊天实体信息，使用默认值');
    }

    return { entityName, chatName };
}

// --- Web Worker 通信 ---
// 发送数据到 Worker 并返回包含拷贝后数据的 Promise
function performDeepCopyInWorker(payload) {
    return new Promise((resolve, reject) => {
        if (!backupWorker) {
            return reject(new Error("Backup worker not initialized."));
        }

        const currentRequestId = ++workerRequestId;
        workerPromises[currentRequestId] = { resolve, reject };

        logDebug(`[主线程] 发送数据到 Worker (ID: ${currentRequestId}), Payload size: ${JSON.stringify(payload).length}`);
        try {
            // 发送需要拷贝的数据
            backupWorker.postMessage({
                id: currentRequestId,
                payload: payload
            });
        } catch (error) {
             console.error(`[主线程] 发送消息到 Worker 失败 (ID: ${currentRequestId}):`, error);
             delete workerPromises[currentRequestId];
             reject(error);
        }
    });
}

// --- 核心备份逻辑封装 ---
async function executeBackupLogic_Core(settings) { // 修改函数签名
    const currentTimestamp = Date.now();
    logDebug(`(封装) 开始执行核心备份逻辑 @ ${new Date(currentTimestamp).toLocaleTimeString()}`);

    // 1. 获取当前上下文和关键信息
    const context = getContext();
    const chatKey = getCurrentChatKey();
    if (!chatKey) {
        console.warn('[聊天自动备份] (封装) 无有效的聊天标识符，无法执行备份');
        return false;
    }

    const { entityName, chatName } = getCurrentChatInfo();
    let fullChatContentArray = null; // 用于存储从API获取的 [metadata, ...messages] 或 {metadata, messages}
    let originalChatMessagesCount = 0; // 用于 lastMessageId

    logDebug(`(封装) 准备备份聊天: ${entityName} - ${chatName}`);

    // --- 新增：从后端API获取完整的聊天文件内容 ---
    try {
        if (context.groupId) { // 群组聊天
            const group = context.groups?.find(g => g.id === context.groupId);
            if (!group || !group.chat_id) {
                throw new Error(`无法找到群组 ${context.groupId} 或其当前聊天ID`);
            }
            
            logDebug(`[API] 获取群组 "${group.id}" 的聊天 "${group.chat_id}" 内容...`);
            
            // 1. 获取消息内容
            const messages = await fetchGroupChatMessages(group.id, group.chat_id);
            if (!messages || !Array.isArray(messages)) {
                throw new Error(`未能获取群组 ${group.id} 聊天 ${group.chat_id} 的消息或返回格式异常`);
            }
            
            // 2. 获取元数据 - 从当前加载的群组聊天中获取
            // 深拷贝确保不引用同一个对象
            let metadata = {};
            // **检查 group.chatMatedata 或 group.chat_metadata（正确方式极有可能是group.chatMatedata而非group.chat_metadata）**
            const groupMetadataField = group.chatMatedata || group.chat_metadata;
            if (groupMetadataField && typeof groupMetadataField === 'object') {
                metadata = structuredClone(groupMetadataField);
                logDebug(`[API] 从群组对象中获取到聊天元数据，键数量: ${Object.keys(metadata).length}`);
            } else {
                logDebug(`[API] 警告: 群组 ${group.id} 的聊天 ${group.chat_id} 没有元数据或元数据无效`);
            }
            
            // 3. 构造完整内容数组 [metadata, ...messages]
            fullChatContentArray = [metadata, ...messages];
            originalChatMessagesCount = messages.length;
            
            logDebug(`[API] 已构造群组聊天完整内容数组，总长度: ${fullChatContentArray.length} (包含元数据)`);
        } else if (context.characterId !== undefined) { // 角色聊天
            const character = characters[context.characterId];
            if (!character || !character.chat) {
                throw new Error(`无法找到角色 ${context.characterId} 或其当前聊天文件名`);
            }
            fullChatContentArray = await fetchCharacterChatContent(character.name, character.chat, character.avatar);
            if (fullChatContentArray && fullChatContentArray.length > 0) {
                originalChatMessagesCount = fullChatContentArray.length - 1; // 第一个是元数据
              } else {
                 throw new Error(`未能获取角色 ${character.name} 聊天 ${character.chat} 的内容，或内容为空`);
              }
         } else {
            throw new Error("无法确定当前是角色还是群组聊天进行备份");
        }

        if (!fullChatContentArray || fullChatContentArray.length === 0) {
            logDebug(`(封装) 从API获取的聊天内容为空或无效，取消备份。ChatKey: ${chatKey}`);
            return false; // 如果获取不到内容，则不备份
        }
        logDebug(`(封装) 从API获取到聊天内容，总条目数: ${fullChatContentArray.length}`);

    } catch (fetchError) {
        console.error('[聊天自动备份] (封装) 获取聊天文件内容时出错:', fetchError);
        toastr.error(`备份失败：无法获取聊天文件内容 - ${fetchError.message}`, '聊天自动备份');
        return false; // 获取失败则不备份
    }

    const lastMsgIndex = originalChatMessagesCount > 0 ? originalChatMessagesCount - 1 : -1; //消息数组的索引
    const lastMessage = lastMsgIndex >= 0 && fullChatContentArray.length > 1 ? fullChatContentArray[lastMsgIndex+1] : null; // +1 因为元数据在前面
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || (originalChatMessagesCount > 0 ? '(消息内容获取失败)' : '(空聊天)');

    try {
        // 2. 使用 Worker 进行深拷贝 (拷贝从API获取的 fullChatContentArray)
        let copiedFullChatContentArray;
        if (backupWorker) {
            try {
                console.time('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('(封装) 请求 Worker 执行深拷贝 fullChatContentArray...');
                copiedFullChatContentArray = await performDeepCopyInWorker(fullChatContentArray);
                console.timeEnd('[聊天自动备份] Web Worker 深拷贝时间');
                logDebug('(封装) 从 Worker 收到拷贝后的 fullChatContentArray');
            } catch(workerError) {
                 console.error('[聊天自动备份] (封装) Worker 深拷贝失败，将尝试在主线程执行:', workerError);
                  console.time('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
                  try { copiedFullChatContentArray = structuredClone(fullChatContentArray); }
                  catch (scError) { copiedFullChatContentArray = JSON.parse(JSON.stringify(fullChatContentArray));}
                  console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (Worker失败后)');
            }
        } else {
            console.time('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
             try { copiedFullChatContentArray = structuredClone(fullChatContentArray); }
             catch (scError) { copiedFullChatContentArray = JSON.parse(JSON.stringify(fullChatContentArray));}
            console.timeEnd('[聊天自动备份] 主线程深拷贝时间 (无Worker)');
        }

        if (!copiedFullChatContentArray) {
             throw new Error("未能获取有效的聊天数据副本 (fullChatContentArray)");
        }

        // 3. 构建备份对象
        const backup = {
            timestamp: currentTimestamp,
            chatKey, // 保持 chatKey 用于识别备份属于哪个原始聊天
            entityName,
            chatName,
            lastMessageId: lastMsgIndex, // 基于消息数量
            lastMessagePreview,
            // 存储完整的聊天文件内容数组
            chatFileContent: copiedFullChatContentArray, // [metadata, ...messages]
        };
        logDebug(`(封装) 构建的备份对象:`, {timestamp: backup.timestamp, chatKey: backup.chatKey, entityName: backup.entityName, chatName: backup.chatName, lastMessageId: backup.lastMessageId, preview: backup.lastMessagePreview, contentItems: backup.chatFileContent.length });

        // 4. 检查当前聊天是否已有基于最后消息ID的备份 (避免完全相同的备份)
        const existingBackups = await getBackupsForChat(chatKey);
        const existingBackupIndex = existingBackups.findIndex(b => b.lastMessageId === lastMsgIndex && b.lastMessageId !== -1); // 只有在有消息时才比较
        let needsSave = true;

        if (lastMsgIndex !== -1 && existingBackupIndex !== -1) {
            const existingTimestamp = existingBackups[existingBackupIndex].timestamp;
            if (backup.timestamp > existingTimestamp) {
                logDebug(`(封装) 发现旧备份 (ID ${lastMsgIndex}, 时间 ${existingTimestamp}), 将删除旧的以保存新的 (时间 ${backup.timestamp})`);
                await deleteBackup(chatKey, existingTimestamp);
            } else {
                logDebug(`(封装) 发现更新或相同的备份 (ID ${lastMsgIndex}, 时间 ${existingTimestamp} vs ${backup.timestamp}), 跳过保存`);
                needsSave = false;
            }
        }

        if (!needsSave) {
            logDebug('(封装) 无需保存 (已存在或无更新), 跳过保存和清理');
            return false;
        }

        // 5. 保存新的备份
        await saveBackupToDB(backup);
        logDebug(`(封装) 新备份已保存: [${chatKey}, ${backup.timestamp}]`);

        // 6. 清理旧备份
        logDebug(`(封装) 检查备份总数是否超出系统限制 (${settings.maxTotalBackups})`);
        const allBackupKeys = await getAllBackupKeys();
        if (allBackupKeys.length > settings.maxTotalBackups) {
            logDebug(`(封装) 备份总数 (${allBackupKeys.length}) 超出限制 (${settings.maxTotalBackups})`);
            allBackupKeys.sort((a, b) => a[1] - b[1]);
            const numToDelete = allBackupKeys.length - settings.maxTotalBackups;
            const keysToDelete = allBackupKeys.slice(0, numToDelete);
            logDebug(`(封装) 准备删除 ${keysToDelete.length} 个最旧的备份`);
            await Promise.all(keysToDelete.map(key => deleteBackup(key[0], key[1])));
            logDebug(`(封装) ${keysToDelete.length} 个旧备份已删除`);
        } else {
            logDebug(`(封装) 备份总数 (${allBackupKeys.length}) 未超出限制，无需清理`);
        }

        logDebug(`(封装) 聊天备份和潜在清理成功: ${entityName} - ${chatName}`);
        return true;

    } catch (error) {
        console.error('[聊天自动备份] (封装) 核心备份或清理过程中发生严重错误:', error);
        throw error;
    }
}


// --- Conditional backup function ---
async function performBackupConditional() {
    if (isBackupInProgress) {
        logDebug('Backup is already in progress, skipping this request');
        return;
    }

    // Get current settings, including debounce delay, in case they were modified during the delay
    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error('[聊天自动备份] Could not get current settings, cancelling backup');
        return false;
    }

    logDebug('Performing conditional backup (performBackupConditional)');
    clearTimeout(backupTimeout); // Cancel any pending debounced backups
    backupTimeout = null;

    const context = getContext();
    const chatKey = getCurrentChatKey();

    if (!chatKey) {
        logDebug('Could not get a valid chat identifier, cancelling backup');
        console.warn('[聊天自动备份] Cancellation Details (No ChatKey):', {
             contextDefined: !!context,
             chatMetadataDefined: !!context?.chatMetadata,
             sheetsDefined: !!context?.chatMetadata?.sheets,
             isSheetsArray: Array.isArray(context?.chatMetadata?.sheets),
             sheetsLength: context?.chatMetadata?.sheets?.length,
             condition1: !context?.chatMetadata,
             condition2: !context?.chatMetadata?.sheets,
             condition3: context?.chatMetadata?.sheets?.length === 0
         });
        return false;
    }
    
    if (!context.chatMetadata) {
        console.warn('[聊天自动备份] chatMetadata is invalid, cancelling backup');
        console.warn('[聊天自动备份] Cancellation Details (chatMetadata Invalid):', {
             contextDefined: !!context, chatMetadataDefined: !!context?.chatMetadata
         });
        return false;
     }

    isBackupInProgress = true;
    logDebug('Setting backup lock');
    try {
        // 修改：直接调用，让 executeBackupLogic_Core 内部获取数据
        const success = await executeBackupLogic_Core(currentSettings);
        if (success) {
            await updateBackupsList();
        }
        return success;
    } catch (error) {
        console.error('[聊天自动备份] Conditional backup execution failed:', error);
        toastr.error(`Backup failed: ${error.message || 'Unknown error'}`, 'Chat Auto Backup');
        return false;
    } finally {
        isBackupInProgress = false;
        logDebug('Releasing backup lock');
    }
}


// --- Debounced backup function (similar to saveChatDebounced) ---
function performBackupDebounced() {
    // Get the context and settings at the time of scheduling
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        logDebug('Could not get ChatKey at the time of scheduling debounced backup, cancelling');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error('[聊天自动备份] Could not get valid debounce delay setting, cancelling debounced backup');
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    const delay = currentSettings.backupDebounceDelay; // Use the current settings' delay

    logDebug(`Scheduling debounced backup (delay ${delay}ms), for ChatKey: ${scheduledChatKey}`);
    clearTimeout(backupTimeout); // Clear the old timer

    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey(); // Get the ChatKey at the time of execution

        // Crucial: Context check
        if (currentChatKey !== scheduledChatKey) {
            logDebug(`Context has changed (Current: ${currentChatKey}, Scheduled: ${scheduledChatKey}), cancelling this debounced backup`);
            backupTimeout = null;
            return; // Abort backup
        }

        logDebug(`Executing delayed backup operation (from debounce), ChatKey: ${currentChatKey}`);
        // Only perform conditional backup if context matches
        await performBackupConditional().catch(error => {
            console.error(`[聊天自动备份] 防抖备份事件 ${currentChatKey} 处理失败:`, error);
        });
        backupTimeout = null; // Clear the timer ID
    }, delay);
}


// --- Manual backup ---
async function performManualBackup() {
    console.log('[聊天自动备份] Performing manual backup (calling conditional function)');
    try {
         await performBackupConditional(); // Manual backup also goes through conditional check and lock logic
         toastr.success('Manual backup of current chat completed', 'Chat Auto Backup');
    } catch (error) {
         // The conditional function already shows an error toast, but log here too.
         console.error('[聊天自动备份] Manual backup failed:', error);
    }
}


// --- Restore logic ---
async function restoreBackup(backupData) {
    logDebug('[聊天自动备份] 开始通过导入API恢复备份:', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });
    logDebug('[聊天自动备份] 原始备份数据:', JSON.parse(JSON.stringify(backupData)));

    // 验证备份数据完整性
    if (!backupData.chatFileContent || !Array.isArray(backupData.chatFileContent) || backupData.chatFileContent.length === 0) {
        toastr.error('备份数据无效：缺少或空的 chatFileContent。', '恢复失败');
        console.error('[聊天自动备份] 备份数据无效，无法恢复。');
        return false;
    }

    // 从 backupData 中获取 entityName 和 chatName
    const originalEntityName = backupData.entityName || '未知实体';
    const originalChatName = backupData.chatName || '未知聊天';

    // 提取原始实体ID
    const isGroupBackup = backupData.chatKey.startsWith('group_');
    let originalEntityId = null;
    
    if (isGroupBackup) {
        // 从 group_GROUPID_chatid 格式中提取 GROUPID
        const match = backupData.chatKey.match(/^group_([^_]+)_/);
        originalEntityId = match ? match[1] : null;
        logDebug(`[聊天自动备份] 从备份 chatKey 中提取的原始群组ID: ${originalEntityId}`);
    } else {
        // 从 char_CHARINDEX_chatid 格式中提取 CHARINDEX
        const match = backupData.chatKey.match(/^char_(\d+)_/);
        originalEntityId = match ? match[1] : null;
        logDebug(`[聊天自动备份] 从备份 chatKey 中提取的原始角色索引: ${originalEntityId}`);
    }

    if (!originalEntityId) {
        toastr.error('无法从备份数据中解析原始实体ID。', '恢复失败');
        console.error('[聊天自动备份] 无法解析原始实体ID，chatKey:', backupData.chatKey);
        return false;
    }

    // 从 chatFileContent 中分离元数据和消息
    const retrievedChatMetadata = structuredClone(backupData.chatFileContent[0]);
    const retrievedChat = structuredClone(backupData.chatFileContent.slice(1));

    if (typeof retrievedChatMetadata !== 'object' || !Array.isArray(retrievedChat)) {
        toastr.error('备份数据格式错误：无法分离元数据和消息。', '恢复失败');
        console.error('[聊天自动备份] 备份数据 chatFileContent 格式错误。');
        return false;
    }
    logDebug(`[聊天自动备份] 从备份中提取元数据 (keys: ${Object.keys(retrievedChatMetadata).length}) 和消息 (count: ${retrievedChat.length})`);

    // 注意: 移除多余的确认对话框，因为确认已在外部UI事件处理中完成

    // --- 2. 构建 .jsonl File 对象 ---
    logDebug('[聊天自动备份] 步骤2: 构建 .jsonl File 对象...');
    const jsonlString = constructJsonlString(retrievedChatMetadata, retrievedChat);
    if (!jsonlString) {
        toastr.error('无法构建 .jsonl 数据，恢复中止。', '恢复失败');
        return false;
    }

    const timestampSuffix = new Date(backupData.timestamp).toISOString().replace(/[:.]/g, '-');
    // 使用原始聊天名和备份时间戳来命名恢复的文件，增加可识别性
    const restoredInternalFilename = `${originalChatName}_restored_${timestampSuffix}.jsonl`;
    const chatFileObject = new File([jsonlString], restoredInternalFilename, { type: "application/json-lines" });
    logDebug(`[聊天自动备份] 已创建 File 对象: ${chatFileObject.name}, 大小: ${chatFileObject.size} bytes`);

    // --- 3. 获取当前上下文以确定导入目标 ---
    const currentContext = getContext();
    const formData = new FormData();
    formData.append('file', chatFileObject);
    formData.append('file_type', 'jsonl');

    let importUrl = '';
    let success = false;

    logDebug('[聊天自动备份] 步骤3: 准备调用导入API...');

    try {
        if (isGroupBackup) { // 恢复到原始群组
            const targetGroupId = originalEntityId; // 使用从备份中提取的原始群组ID
            const targetGroup = context.groups?.find(g => g.id === targetGroupId);
            
            if (!targetGroup) {
                toastr.error(`原始群组 (ID: ${targetGroupId}) 不存在，无法恢复。请确保该群组已经被加载或创建。`, '恢复失败');
                logDebug(`[聊天自动备份] 找不到原始群组 ${targetGroupId}，恢复失败。可用的群组IDs: ${context.groups?.map(g => g.id).join(', ') || '无'}`);
            return false;
        }
            
            logDebug(`[聊天自动备份] 准备将备份导入到原始群组: ${targetGroup.name} (ID: ${targetGroupId})`);

            importUrl = '/api/chats/group/import';
            formData.append('group_id', targetGroupId); // 使用原始群组ID

            const response = await fetch(importUrl, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: formData,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({ error: '未知API错误' }));
                throw new Error(`群组聊天导入API失败: ${response.status} - ${errorData.error}`);
            }
            
            const importResult = await response.json();
            logDebug(`[聊天自动备份] 群组聊天导入API响应:`, importResult);

            if (importResult.res) { // importResult.res 是新创建的聊天ID
                const newGroupChatId = importResult.res;
                logDebug(`[聊天自动备份] 群组聊天导入成功，新聊天ID: ${newGroupChatId}。`);

                // --- 新增：检查当前上下文是否需要切换到目标群组 ---
                const currentContextBeforeOpenGroup = getContext();
                if (String(currentContextBeforeOpenGroup.groupId) !== String(targetGroupId)) {
                    logDebug(`[聊天自动备份] 当前群组 (ID: ${currentContextBeforeOpenGroup.groupId}) 与目标恢复群组 (ID: ${targetGroupId}) 不同，select_group_chats 将处理切换...`);
                    // 在这种情况下 select_group_chats 将同时处理群组切换和聊天加载
                } else {
                    logDebug(`[聊天自动备份] 当前已在目标恢复群组 (ID: ${targetGroupId}) 上下文中，只需加载新聊天。`);
                    // 即使在同一群组中，select_group_chats 也应该正确处理只切换聊天而不重新加载整个群组的情况
                }
                // --- 检查逻辑结束 ---

                logDebug(`[聊天自动备份] 正在加载新导入的群组聊天: ${newGroupChatId} 到群组 ${targetGroupId}...`);
                await select_group_chats(targetGroupId, newGroupChatId); // 加载新导入的聊天
                
                toastr.success(`备份已作为新聊天 "${newGroupChatId}" 导入到群组 "${targetGroup.name}"！`);
                success = true;
        } else {
                throw new Error('群组聊天导入API未返回有效的聊天ID。');
            }
        } else if (!isGroupBackup) { // 恢复到原始角色
            const targetCharacterIndex = parseInt(originalEntityId, 10);
            
            if (isNaN(targetCharacterIndex) || targetCharacterIndex < 0 || targetCharacterIndex >= characters.length) {
                toastr.error(`备份中的原始角色索引 (${originalEntityId}) 无效或超出范围。`, '恢复失败');
                logDebug(`[聊天自动备份] 原始角色索引 ${originalEntityId} 无效，characters数组长度: ${characters.length}`);
                return false;
            }
            
            const targetCharacter = characters[targetCharacterIndex];
            if (!targetCharacter) {
                toastr.error(`无法找到备份对应的原始角色 (索引: ${targetCharacterIndex})。`, '恢复失败');
                return false;
            }
            
            logDebug(`[聊天自动备份] 准备将备份内容作为新聊天保存到原始角色: ${targetCharacter.name} (索引: ${targetCharacterIndex})`);

            // 对于角色，使用 /api/chats/save 来创建一个新的聊天文件
            const newChatIdForRole = chatFileObject.name.replace('.jsonl', '');
            const chatToSaveForRole = [retrievedChatMetadata, ...retrievedChat];

            const saveResponse = await fetch('/api/chats/save', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: targetCharacter.name,
                    file_name: newChatIdForRole,
                    chat: chatToSaveForRole,
                    avatar_url: targetCharacter.avatar,
                    force: false // 保留false，避免意外覆盖，如有冲突将报错
                }),
            });
            
            if (!saveResponse.ok) {
                const errorText = await saveResponse.text();
                throw new Error(`保存角色聊天API失败: ${saveResponse.status} - ${errorText}`);
            }
            
            logDebug(`[聊天自动备份] 角色聊天内容已通过 /api/chats/save 保存为: ${newChatIdForRole}.jsonl`);

            // --- 新增：检查当前上下文是否需要切换到目标角色 ---
            const currentContextBeforeOpen = getContext();
            if (String(currentContextBeforeOpen.characterId) !== String(targetCharacterIndex)) {
                logDebug(`[聊天自动备份] 当前角色 (ID: ${currentContextBeforeOpen.characterId}) 与目标恢复角色 (索引: ${targetCharacterIndex}) 不同，执行切换...`);
                await selectCharacterById(targetCharacterIndex);
                // 在切换角色后，添加短暂延迟以确保SillyTavern的上下文和UI稳定
                await new Promise(resolve => setTimeout(resolve, 300)); 
                logDebug(`[聊天自动备份] 已切换到目标角色 (索引: ${targetCharacterIndex})`);
            } else {
                logDebug(`[聊天自动备份] 当前已在目标恢复角色 (索引: ${targetCharacterIndex}) 上下文中，无需切换角色。`);
            }
            // --- 检查和切换逻辑结束 ---

            // 打开新保存的聊天文件 (此时应该已经在正确的角色上下文中了)
            await openCharacterChat(newChatIdForRole);
            
            toastr.success(`备份已作为新聊天 "${newChatIdForRole}" 恢复到角色 "${targetCharacter.name}"！`);
            success = true;
                    } else {
            toastr.error('未选择任何角色或群组，无法确定恢复目标。', '恢复失败');
            return false;
        }

        if (success) {
            logDebug('[聊天自动备份] 恢复流程成功完成。');
            // 刷新备份列表
            if (typeof updateBackupsList === 'function') {
                 await updateBackupsList(); 
            }
        }
        return success;

        } catch (error) {
        console.error(`[聊天自动备份] 通过导入API恢复备份时发生严重错误:`, error);
        toastr.error(`恢复备份失败: ${error.message}`, '恢复失败');
        return false;
    }
}

// --- 更新备份列表UI ---
async function updateBackupsList() {
    console.log('[聊天自动备份] 开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn('[聊天自动备份] 找不到备份列表容器元素 #chat_backup_list');
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
        logDebug(`渲染 ${allBackups.length} 个备份`);

        allBackups.forEach(backup => {
            const date = new Date(backup.timestamp);
            // 使用更可靠和本地化的格式
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
                        <button class="menu_button backup_restore" title="恢复此备份到新聊天" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">删除</button>
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        console.log('[聊天自动备份] 备份列表渲染完成');
    } catch (error) {
        console.error('[聊天自动备份] 更新备份列表失败:', error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}

// --- 初始化与事件绑定 ---
jQuery(async () => {
    console.log('[聊天自动备份] 插件开始加载...');

    // 初始化设置
    const settings = initSettings();

    // 防止重复初始化的标志位
    let isInitialized = false;

    // --- 将各个初始化步骤拆分成独立函数 ---
    
    // 初始化数据库
    const initializeDatabase = async () => {
        console.log('[聊天自动备份] 初始化数据库');
        try {
            await initDatabase();
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 数据库初始化失败:', error);
            return false;
        }
    };
    
    // 初始化Web Worker
    const initializeWebWorker = () => {
        console.log('[聊天自动备份] 初始化Web Worker');
        try {
            const blob = new Blob([deepCopyLogicString], { type: 'application/javascript' });
            backupWorker = new Worker(URL.createObjectURL(blob));
            console.log('[聊天自动备份] Web Worker 已创建');

            // 设置 Worker 消息处理器 (主线程)
            backupWorker.onmessage = function(e) {
                const { id, result, error } = e.data;
                const promise = workerPromises[id];
                
                if (promise) {
                    if (error) {
                        console.error(`[主线程] Worker 返回错误 (ID: ${id}):`, error);
                        promise.reject(new Error(error));
                    } else {
                        promise.resolve(result);
                    }
                    delete workerPromises[id];
                } else {
                    console.warn(`[主线程] 收到未知或已处理的 Worker 消息 (ID: ${id})`);
                }
            };

            // 设置 Worker 错误处理器 (主线程)
            backupWorker.onerror = function(error) {
                console.error('[聊天自动备份] Web Worker 发生错误:', error);
                 // 拒绝所有待处理的 Promise
                 Object.keys(workerPromises).forEach(id => {
                     workerPromises[id].reject(new Error('Worker encountered an unrecoverable error.'));
                     delete workerPromises[id];
                 });
                toastr.error('备份 Worker 发生错误，自动备份可能已停止', '聊天自动备份');
            };
            
            return true;
        } catch (workerError) {
            console.error('[聊天自动备份] 创建 Web Worker 失败:', workerError);
            backupWorker = null; // 确保 worker 实例为空
            toastr.error('无法创建备份 Worker，将回退到主线程备份（性能较低）', '聊天自动备份');
            return false;
        }
    };
    
    // 加载插件UI
    const initializePluginUI = async () => {
        console.log('[聊天自动备份] 初始化插件UI');
        try {
            // 加载模板
            const settingsHtml = await renderExtensionTemplateAsync(
                `third-party/${PLUGIN_NAME}`,
                'settings'
            );
            $('#extensions_settings').append(settingsHtml);
            console.log('[聊天自动备份] 已添加设置界面');

            // 设置控制项
            const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
            $settingsBlock.html(`
                <div style="margin-bottom: 8px;">
                    <label style="display: inline-block; min-width: 120px;">防抖延迟 (ms):</label>
                    <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}" 
                        min="300" max="30000" step="100" title="编辑或删除消息后，等待多少毫秒再执行备份 (建议 1000-1500)" 
                        style="width: 80px;" />
                </div>
                <div>
                    <label style="display: inline-block; min-width: 120px;">系统最大备份数:</label>
                    <input type="number" id="chat_backup_max_total" value="${settings.maxTotalBackups}" 
                        min="1" max="50" step="1" title="系统中保留的最大备份数量" 
                        style="width: 80px;" />
                </div>
            `);
            $('.chat_backup_controls').prepend($settingsBlock);
            
            return true;
        } catch (error) {
            console.error('[聊天自动备份] 初始化插件UI失败:', error);
            return false;
        }
    };
    
    // 设置UI控件事件监听
    const setupUIEvents = () => {
        console.log('[聊天自动备份] 设置UI事件监听');
        
        // 添加最大备份数设置监听
        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 50) {
                settings.maxTotalBackups = total;
                logDebug(`系统最大备份数已更新为: ${total}`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的系统最大备份数输入: ${$(this).val()}`);
                $(this).val(settings.maxTotalBackups);
            }
        });

        // --- 使用事件委托绑定UI事件 ---
        $(document).on('click', '#chat_backup_manual_backup', performManualBackup);

        // 防抖延迟设置
        $(document).on('input', '#chat_backup_debounce_delay', function() {
            const delay = parseInt($(this).val(), 10);
            if (!isNaN(delay) && delay >= 300 && delay <= 30000) {
                settings.backupDebounceDelay = delay;
                logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                logDebug(`无效的防抖延迟输入: ${$(this).val()}`);
                $(this).val(settings.backupDebounceDelay);
            }
        });

        // 恢复按钮
        $(document).on('click', '.backup_restore', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            button.prop('disabled', true).text('恢复中...'); // 禁用按钮并显示状态

            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    
                    transaction.onerror = (event) => {
                        reject(event.target.error);
                    };
                    
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    
                    request.onsuccess = () => {
                        resolve(request.result);
                    };
                    
                    request.onerror = (event) => {
                        reject(event.target.error);
                    };
                });

                if (backup) {
                    if (confirm(`确定要恢复 " ${backup.entityName} - ${backup.chatName} " 的备份吗？\n\n这将选中对应的角色/群组，并创建一个【新的聊天】来恢复备份内容。\n\n当前聊天内容不会丢失，但请确保已保存。`)) {
                        await restoreBackup(backup);
                    } else {
                         // 用户取消确认对话框
                         console.log('[聊天自动备份] 用户取消恢复操作');
                    }
                } else {
                    console.error('[聊天自动备份] 找不到指定的备份:', { timestamp, chatKey });
                    toastr.error('找不到指定的备份');
                }
            } catch (error) {
                console.error('[聊天自动备份] 恢复过程中出错:', error);
                toastr.error(`恢复过程中出错: ${error.message}`);
            } finally {
                button.prop('disabled', false).text('恢复'); // 恢复按钮状态
            }
        });

        // 删除按钮
        $(document).on('click', '.backup_delete', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击删除按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

            const backupItem = button.closest('.backup_item');
            const entityName = backupItem.find('.backup_entity').text();
            const chatName = backupItem.find('.backup_chat').text();
            const date = backupItem.find('.backup_date').text();

            if (confirm(`确定要永久删除这个备份吗？\n\n实体: ${entityName}\n聊天: ${chatName}\n时间: ${date}\n\n此操作无法撤销！`)) {
                button.prop('disabled', true).text('删除中...');
                try {
                    await deleteBackup(chatKey, timestamp);
                    toastr.success('备份已删除');
                    backupItem.fadeOut(300, function() { $(this).remove(); }); // 平滑移除条目
                    // 可选：如果列表为空，显示提示
                    if ($('#chat_backup_list .backup_item').length <= 1) { // <=1 因为当前这个还在DOM里，将要移除
                        updateBackupsList(); // 重新加载以显示"无备份"提示
                    }
                } catch (error) {
                    console.error('[聊天自动备份] 删除备份失败:', error);
                    toastr.error(`删除备份失败: ${error.message}`);
                    button.prop('disabled', false).text('删除');
                }
            }
        });

        // 预览按钮
        $(document).on('click', '.backup_preview_btn', async function() {
            const button = $(this);
            const timestamp = parseInt(button.data('timestamp'));
            const chatKey = button.data('key');
            logDebug(`点击预览按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);
            button.prop('disabled', true).text('加载中...'); // 禁用按钮并显示状态
            
            try {
                const db = await getDB();
                const backup = await new Promise((resolve, reject) => {
                    const transaction = db.transaction([STORE_NAME], 'readonly');
                    
                    transaction.onerror = (event) => {
                        reject(event.target.error);
                    };
                    
                    const store = transaction.objectStore(STORE_NAME);
                    const request = store.get([chatKey, timestamp]);
                    
                    request.onsuccess = () => {
                        resolve(request.result);
                    };
                    
                    request.onerror = (event) => {
                        reject(event.target.error);
                    };
                });

                if (backup && backup.chatFileContent && Array.isArray(backup.chatFileContent) && backup.chatFileContent.length > 1) {
                    // 提取消息 (跳过索引0的元数据)
                    const messages = backup.chatFileContent.slice(1);
                    
                    if (messages.length > 0) {
                        // 获取最后两条消息
                        const lastMessages = messages.slice(-2);
                        
                        // 过滤标签并处理Markdown
                        const processMessage = (messageText) => {
                            // 确保 messageText 是字符串类型
                            if (typeof messageText !== 'string') {
                                if (messageText === null || messageText === undefined) {
                                    return '(空消息)';
                                }
                                
                                // 如果 messageText 是对象，尝试从中提取 mes 属性
                                if (typeof messageText === 'object' && messageText !== null) {
                                    if (typeof messageText.mes === 'string') {
                                        messageText = messageText.mes;
                                    } else {
                                        console.warn(`[聊天自动备份] processMessage 收到非字符串类型的消息:`, messageText);
                                        messageText = String(messageText); // 尝试转换为字符串
                                    }
                                } else {
                                    // 其他非字符串类型
                                    console.warn(`[聊天自动备份] processMessage 收到非字符串类型的消息:`, messageText);
                                    messageText = String(messageText); // 尝试转换为字符串
                                }
                            }
                            
                            if (!messageText) return '(空消息)';
                            
                            // 过滤<think>和<thinking>标签及其内容
                            let processed = messageText
                                .replace(/<think>[\s\S]*?<\/think>/g, '')
                                .replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
                            
                            // 过滤代码块和白毛控名称
                            processed = processed
                                .replace(/```[\s\S]*?```/g, '')    // 移除代码块
                                .replace(/`[\s\S]*?`/g, '');       // 移除内联代码
                            
                            // 简单的Markdown处理，保留部分格式
                            processed = processed
                                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')  // 粗体
                                .replace(/\*(.*?)\*/g, '<em>$1</em>')              // 斜体
                                .replace(/\n\n+/g, '\n')                           // 多个连续换行替换为单个
                                .replace(/\n/g, '<br>');                           // 换行
                            
                            return processed;
                        };
                        
                        // 创建样式
                        const style = document.createElement('style');
                        style.textContent = `
                            .message_box {
                                padding: 10px;
                                margin-bottom: 10px;
                                border-radius: 8px;
                                max-width: 80%;
                            }
                            .user_message {
                                background-color: #e1f5fe;
                                margin-left: auto;
                            }
                            .assistant_message {
                                background-color: #f5f5f5;
                                margin-right: auto;
                            }
                            .preview_container {
                                display: flex;
                                flex-direction: column;
                                padding: 10px;
                                max-height: 400px;
                                overflow-y: auto;
                            }
                        `;
                        document.head.appendChild(style);
                        
                        // 创建预览容器
                        const previewContainer = document.createElement('div');
                        previewContainer.className = 'preview_container';
                        
                        // 添加消息
                        lastMessages.forEach((msg, index) => {
                            const messageDiv = document.createElement('div');
                            messageDiv.className = `message_box ${index % 2 === 0 ? 'user_message' : 'assistant_message'}`;
                            // 检查消息格式并访问正确的属性
                            messageDiv.innerHTML = processMessage(msg.mes || msg);
                            previewContainer.appendChild(messageDiv);
                        });
                        
                        // 显示预览
                        const previewModal = document.createElement('div');
                        previewModal.className = 'preview_modal';
                        previewModal.appendChild(previewContainer);
                        document.body.appendChild(previewModal);
                    }
                } else {
                    alert('无法加载预览内容或备份格式不正确');
                }
            } catch (error) {
                console.error('预览备份时出错:', error);
                alert('预览备份时出错: ' + error.message);
            } finally {
                button.prop('disabled', false).text('预览');
            }
        });

        // 调试开关
        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            console.log('[聊天自动备份] 调试模式已' + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });
        
        // 监听扩展页面打开事件，刷新列表
        $(document).on('click', '#extensionsMenuButton', () => {
            if ($('#chat_auto_backup_settings').is(':visible')) {
                console.log('[聊天自动备份] 扩展菜单按钮点击，且本插件设置可见，刷新备份列表');
                setTimeout(updateBackupsList, 200); // 稍作延迟确保面板内容已加载
            }
        });

        // 抽屉打开时也刷新
        $(document).on('click', '#chat_auto_backup_settings .inline-drawer-toggle', function() {
            const drawer = $(this).closest('.inline-drawer');
            // 检查抽屉是否即将打开 (基于当前是否有 open class)
            if (!drawer.hasClass('open')) {
                console.log('[聊天自动备份] 插件设置抽屉打开，刷新备份列表');
                setTimeout(updateBackupsList, 50); // 几乎立即刷新
            }
        });
    };
    
    // 初始化UI状态
    const initializeUIState = async () => {
        console.log('[聊天自动备份] 初始化UI状态');
        $('#chat_backup_debug_toggle').prop('checked', settings.debug);
        $('#chat_backup_debounce_delay').val(settings.backupDebounceDelay);
        $('#chat_backup_max_total').val(settings.maxTotalBackups);
        await updateBackupsList();
    };
    
    // 设置备份事件监听
    const setupBackupEvents = () => {
        console.log('[聊天自动备份] 设置备份事件监听');
        
        // 立即触发备份的事件 (状态明确结束)
        const immediateBackupEvents = [
            event_types.MESSAGE_SENT,           // 用户发送消息后
            event_types.GENERATION_ENDED,       // AI生成完成并添加消息后
            event_types.CHARACTER_FIRST_MESSAGE_SELECTED, // 选择角色第一条消息时                
        ].filter(Boolean); // 过滤掉可能不存在的事件类型

        // 触发防抖备份的事件 (编辑性操作)
        const debouncedBackupEvents = [
            event_types.MESSAGE_EDITED,        // 编辑消息后 (防抖)
            event_types.MESSAGE_DELETED,       // 删除消息后 (防抖)
            event_types.MESSAGE_SWIPED,         // 用户切换AI回复后 (防抖)
            event_types.IMAGE_SWIPED,           // 图片切换 (防抖)
            event_types.MESSAGE_FILE_EMBEDDED, // 文件嵌入 (防抖)
            event_types.MESSAGE_REASONING_EDITED, // 编辑推理 (防抖)
            event_types.MESSAGE_REASONING_DELETED, // 删除推理 (防抖)
            event_types.FILE_ATTACHMENT_DELETED, // 附件删除 (防抖)
            event_types.GROUP_UPDATED, // 群组元数据更新 (防抖)
        ].filter(Boolean);

        console.log('[聊天自动备份] 设置立即备份事件监听:', immediateBackupEvents);
        immediateBackupEvents.forEach(eventType => {
            if (!eventType) {
                console.warn('[聊天自动备份] 检测到未定义的立即备份事件类型');
                return;
            }
            eventSource.on(eventType, () => {
                logDebug(`事件触发 (立即备份): ${eventType}`);
                // 使用新的条件备份函数
                performBackupConditional().catch(error => {
                    console.error(`[聊天自动备份] 立即备份事件 ${eventType} 处理失败:`, error);
                });
            });
        });

        console.log('[聊天自动备份] 设置防抖备份事件监听:', debouncedBackupEvents);
        debouncedBackupEvents.forEach(eventType => {
            if (!eventType) {
                console.warn('[聊天自动备份] 检测到未定义的防抖备份事件类型');
                return;
            }
            eventSource.on(eventType, () => {
                logDebug(`事件触发 (防抖备份): ${eventType}`);
                // 使用新的防抖备份函数
                performBackupDebounced();
            });
        });

        console.log('[聊天自动备份] 事件监听器设置完成');
    };
    
    // 执行初始备份检查
    const performInitialBackupCheck = async () => {
        console.log('[聊天自动备份] 执行初始备份检查');
        try {
            const context = getContext();
            if (context.chat && context.chat.length > 0 && !isBackupInProgress) {
                logDebug('[聊天自动备份] 发现现有聊天记录，执行初始备份');
                await performBackupConditional(); // 使用条件函数
            } else {
                logDebug('[聊天自动备份] 当前没有聊天记录或备份进行中，跳过初始备份');
            }
        } catch (error) {
            console.error('[聊天自动备份] 初始备份执行失败:', error);
        }
    };

    // --- 主初始化函数 ---
    const initializeExtension = async () => {
        if (isInitialized) {
            console.log('[聊天自动备份] 初始化已运行。跳过。');
            return;
        }
        isInitialized = true;
        console.log('[聊天自动备份] 由 app_ready 事件触发，运行初始化任务。');
        
        try {
            // 顺序执行初始化任务
            if (!await initializeDatabase()) {
                console.warn('[聊天自动备份] 数据库初始化失败，但将尝试继续');
            }
            
            initializeWebWorker();
            
            if (!await initializePluginUI()) {
                console.warn('[聊天自动备份] 插件UI初始化失败，但将尝试继续');
            }
            
            setupUIEvents();
            setupBackupEvents();
            
            await initializeUIState();
            
            // 延迟一小段时间后执行初始备份检查，确保系统已经稳定
            setTimeout(performInitialBackupCheck, 1000);
            
            console.log('[聊天自动备份] 插件加载完成');
        } catch (error) {
            console.error('[聊天自动备份] 插件加载过程中发生严重错误:', error);
            $('#extensions_settings').append(
                '<div class="error">聊天自动备份插件加载失败，请检查控制台。</div>'
            );
        }
    };

    // --- 监听SillyTavern的app_ready事件 ---
    eventSource.on('app_ready', initializeExtension);
    
    // 如果事件已经错过，则直接初始化
    if (window.SillyTavern?.appReady) {
        console.log('[聊天自动备份] app_ready已发生，直接初始化');
        initializeExtension();
    } else {
        console.log('[聊天自动备份] 等待app_ready事件触发初始化');
        // 设置安全兜底，确保插件最终会初始化
        setTimeout(() => {
            if (!isInitialized) {
                console.warn('[聊天自动备份] app_ready事件未触发，使用兜底机制初始化');
                initializeExtension();
            }
        }, 3000); // 3秒后如果仍未初始化，则强制初始化
    }
});
