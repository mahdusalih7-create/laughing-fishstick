const { Client, GatewayIntentBits, AttachmentBuilder } = require('discord.js');
const axios = require('axios');

const TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ============================================
// منطق فك التشفير (نفس الـ HTML)
// ============================================

function detectType(code) {
    if (/LOL!/.test(code)) return 'LOL';
    if (/IronBrew/.test(code) || /\bVM\s*=\s*\{/.test(code)) return 'IronBrew';
    if (/Luraph/.test(code)) return 'Luraph';
    if (/loadstring.*base64/is.test(code)) return 'Base64';
    return 'Generic';
}

function decodeLOLBytes(hexStr) {
    const b = [];
    let i = 0;
    while (i < hexStr.length) {
        if (i + 1 < hexStr.length && hexStr[i + 1] === 'Q') {
            const cnt = parseInt(hexStr[i], 16);
            const val = parseInt(hexStr.substr(i + 2, 2), 16);
            if (!isNaN(cnt) && !isNaN(val)) {
                for (let k = 0; k < cnt; k++) b.push(val);
            }
            i += 4;
        } else {
            const v = parseInt(hexStr.substr(i, 2), 16);
            if (!isNaN(v)) b.push(v);
            i += 2;
        }
    }
    return b;
}

function extractLOLStrings(bytes) {
    const strs = [];
    let i = 1;
    while (i < bytes.length - 6) {
        if (bytes[i] === 0x03) {
            const len = bytes[i + 1];
            if (len > 0 && len <= 250 && bytes[i+2]===0 && bytes[i+3]===0 && bytes[i+4]===0) {
                let s = '', ok = true;
                for (let j = 0; j < len; j++) {
                    const c = bytes[i + 5 + j];
                    if (c === undefined) { ok = false; break; }
                    s += String.fromCharCode(c);
                }
                if (ok && s.length === len) { strs.push(s); i += 5 + len; continue; }
            }
        }
        i++;
    }
    return strs;
}

function extractLOLNumbers(bytes) {
    const nums = [];
    let i = 1;
    while (i < bytes.length - 10) {
        if (bytes[i] === 0x02) {
            const arr = new Uint8Array(8);
            for (let j = 0; j < 8; j++) arr[j] = bytes[i + 1 + j] || 0;
            const v = new DataView(arr.buffer).getFloat64(0, true);
            if (isFinite(v) && v !== 0) { nums.push(v); i += 9; continue; }
        }
        i++;
    }
    return nums;
}

function extractVarMap(code) {
    const map = {};
    const known = [
        ['tonumber','tonumber'],['string\\.byte','string.byte'],
        ['string\\.char','string.char'],['string\\.sub','string.sub'],
        ['string\\.gsub','string.gsub'],['string\\.rep','string.rep'],
        ['string\\.format','string.format'],['string\\.find','string.find'],
        ['table\\.concat','table.concat'],['table\\.insert','table.insert'],
        ['table\\.unpack','table.unpack'],['math\\.floor','math.floor'],
        ['math\\.abs','math.abs'],['getfenv','getfenv'],
        ['setmetatable','setmetatable'],['pcall','pcall'],
        ['load','load'],['loadstring','loadstring'],
        ['type','type'],['pairs','pairs'],['ipairs','ipairs'],
        ['tostring','tostring'],['print','print'],
    ];
    for (const [pat, name] of known) {
        const re = new RegExp('local\\s+(v\\d+)\\s*=\\s*' + pat + '(?:\\s+or\\b[^;\\n]+)?', 'g');
        let m;
        while ((m = re.exec(code)) !== null) map[m[1]] = name;
    }
    return map;
}

function simplMath(code) {
    let prev = '', safety = 0;
    while (prev !== code && safety++ < 20) {
        prev = code;
        code = code.replace(/\(\s*(\d+)\s*\+\s*(\d+)\s*/g, (_, a, b) => String(+a + +b));
        code = code.replace(/\s*(\d+)\s*-\s*(\d+)\s*/g, (_, a, b) => {
            const r = +a - +b;
            return r >= 0 ? String(r) : _;
        });
    }
    return code;
}

function applyVarMap(code, map) {
    for (const [v, name] of Object.entries(map)) {
        code = code.replace(new RegExp('\\b' + v + '\\b', 'g'), name);
    }
    return code;
}

function genericStrings(code) {
    const s = new Set();
    for (const m of code.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
        const v = m[1] || m[2];
        if (v && v.length > 1 && !/^\s*$/.test(v)) s.add(v);
    }
    return [...s];
}

function escStr(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function reconstructLOL(strings, numbers) {
    const L = [];
    const urls = strings.filter(s => /^https?:\/\//i.test(s));
    const svcList = ['Players','RunService','UserInputService','TweenService',
                     'HttpService','ReplicatedStorage','Workspace','Lighting']
                    .filter(s => strings.includes(s));

    L.push('--[[\n  كود Roblox المُفكّ -- LuaDecrypt\n  ' +
           strings.length + ' ثابت نصي -- ' + urls.length + ' رابط\n]]');
    L.push('');

    if (svcList.length) {
        L.push('-- الخدمات');
        svcList.forEach(s => L.push(`local ${s} = game:GetService("${s}")`));
        L.push('');
    }

    if (strings.includes('LocalPlayer') || strings.includes('Players')) {
        L.push('-- اللاعب');
        L.push('local Players = game:GetService("Players")');
        L.push('local LocalPlayer = Players.LocalPlayer');
        L.push('');
    }

    if (urls.length) {
        L.push('-- الروابط المكتشفة');
        urls.forEach((u, i) => L.push(`-- [${i+1}] ${u}`));
        L.push('');
    }

    L.push('-- جميع الثوابت المستخرجة');
    strings.filter(s => s.length > 1).forEach((s, i) => {
        L.push(`-- [${String(i).padStart(3,'0')}] "${escStr(s)}"`);
    });

    return L.join('\n');
}

function deobfuscate(code) {
    const type = detectType(code);
    const varMap = extractVarMap(code);
    let result = '';
    let strings = [];
    let urls = [];

    if (type === 'LOL') {
        const hm = code.match(/"LOL!([A-F0-9Q]+)"/i);
        if (hm) {
            const bytes = decodeLOLBytes(hm[1]);
            strings = extractLOLStrings(bytes);
            const numbers = extractLOLNumbers(bytes);
            urls = strings.filter(s => /^https?:\/\//i.test(s));
            result = reconstructLOL(strings, numbers);
        } else {
            strings = genericStrings(code);
            urls = strings.filter(s => /^https?:\/\//i.test(s));
            result = '-- [[ LuaDecrypt -- فك عام ]]\n\n' + applyVarMap(simplMath(code), varMap);
        }
    } else {
        strings = genericStrings(code);
        urls = strings.filter(s => /^https?:\/\//i.test(s));
        result = '-- [[ LuaDecrypt -- فك عام ]]\n\n' + applyVarMap(simplMath(code), varMap);
    }

    return { result, type, strings, urls };
}

// ============================================
// البوت
// ============================================

client.once('ready', () => {
    console.log('✅ البوت شغال: ' + client.user.tag);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // امر المساعدة
    if (message.content === '.help') {
        return message.reply(
            '**🤖 أوامر البوت:**\n\n' +
            '`.d` + رابط: فك تشفير كود من رابط\n' +
            '`.d` + ملف `.lua`: فك تشفير ملف\n' +
            '`.d` + كود بين ` ``` `: فك تشفير مباشر\n\n' +
            '**مثال:**\n' +
            '`.d https://raw.githubusercontent.com/.../script.lua`'
        );
    }

    // امر فك التشفير
    if (message.content.startsWith('.d')) {
        let code = '';
        let loadMsg = await message.reply('⏳ جاري المعالجة...');

        try {
            // حالة 1: رابط
            if (message.content.includes('http')) {
                const url = message.content.split(' ')[1];
                await loadMsg.edit('⏳ جاري تحميل الرابط...');
                const res = await axios.get(url, { timeout: 10000 });
                code = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

            // حالة 2: ملف
            } else if (message.attachments.size > 0) {
                const file = message.attachments.first();
                if (!file.name.endsWith('.lua') && !file.name.endsWith('.txt')) {
                    return loadMsg.edit('❌ الملف لازم يكون `.lua` أو `.txt`');
                }
                await loadMsg.edit('⏳ جاري قراءة الملف...');
                const res = await axios.get(file.url);
                code = res.data;

            // حالة 3: كود مباشر
            } else {
                const match = message.content.match(/```(?:lua)?\n?([\s\S]+?)```/);
                if (match) code = match[1];
            }

            if (!code) {
                return loadMsg.edit(
                    '❌ ما لقيت كود!\n' +
                    'اكتب `.help` للمساعدة'
                );
            }

            await loadMsg.edit('🔄 جاري فك التشفير...');

            // فك التشفير
            const { result, type, strings, urls } = deobfuscate(code);

            // بناء الرسالة
            const statsText =
                `\n📊 **النوع:** ${type}` +
                ` | **الثوابت:** ${strings.length}` +
                ` | **الروابط:** ${urls.length}`;

            const urlsText = urls.length
                ? '\n🔗 **روابط مكتشفة:**\n' + urls.map(u => `> ${u}`).join('\n')
                : '';

            // اذا قصير ارسله مباشر
            if (result.length < 1800) {
                await loadMsg.edit(
                    '✅ **تم فك التشفير:**' + statsText + urlsText + '\n' +
                    '```lua\n' + result.slice(0, 1700) + '\n```'
                );

            // اذا طويل ارسله كملف
            } else {
                const buffer = Buffer.from(result, 'utf8');
                const attachment = new AttachmentBuilder(buffer, {
                    name: 'deobfuscated.lua'
                });
                await loadMsg.delete();
                await message.reply({
                    content: '✅ **تم فك التشفير**' + statsText + urlsText,
                    files: [attachment]
                });
            }

        } catch (err) {
            console.error(err);
            await loadMsg.edit('❌ صار خطأ: ' + err.message);
        }
    }
});

client.login(TOKEN);, 
