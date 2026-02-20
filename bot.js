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

function detectType(code) {
    if (/LOL!/.test(code)) return 'LOL';
    if (/IronBrew/.test(code)) return 'IronBrew';
    if (/Luraph/.test(code)) return 'Luraph';
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
                for (let k = 0; k < cnt; k++) {
                    b.push(val);
                }
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
            if (len > 0 && len <= 250 && bytes[i+2] === 0 && bytes[i+3] === 0 && bytes[i+4] === 0) {
                let s = '';
                let ok = true;
                for (let j = 0; j < len; j++) {
                    const c = bytes[i + 5 + j];
                    if (c === undefined) {
                        ok = false;
                        break;
                    }
                    s += String.fromCharCode(c);
                }
                if (ok && s.length === len) {
                    strs.push(s);
                    i += 5 + len;
                    continue;
                }
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
            const buf = Buffer.from(bytes.slice(i + 1, i + 9));
            const v = buf.readDoubleLE(0);
            if (isFinite(v) && v !== 0) {
                nums.push(v);
                i += 9;
                continue;
            }
        }
        i++;
    }
    return nums;
}

function extractVarMap(code) {
    const map = {};
    const known = [
        ['tonumber', 'tonumber'],
        ['string\\.byte', 'string.byte'],
        ['string\\.char', 'string.char'],
        ['string\\.sub', 'string.sub'],
        ['string\\.gsub', 'string.gsub'],
        ['string\\.rep', 'string.rep'],
        ['string\\.format', 'string.format'],
        ['string\\.find', 'string.find'],
        ['table\\.concat', 'table.concat'],
        ['table\\.insert', 'table.insert'],
        ['table\\.unpack', 'table.unpack'],
        ['math\\.floor', 'math.floor'],
        ['math\\.abs', 'math.abs'],
        ['setmetatable', 'setmetatable'],
        ['pcall', 'pcall'],
        ['loadstring', 'loadstring'],
        ['type', 'type'],
        ['pairs', 'pairs'],
        ['ipairs', 'ipairs'],
        ['tostring', 'tostring'],
        ['print', 'print']
    ];
    for (let idx = 0; idx < known.length; idx++) {
        const pat = known[idx][0];
        const name = known[idx][1];
        const re = new RegExp('local\\s+(v\\d+)\\s*=\\s*' + pat, 'g');
        let m;
        while ((m = re.exec(code)) !== null) {
            map[m[1]] = name;
        }
    }
    return map;
}

function simplMath(code) {
    let prev = '';
    let safety = 0;
    while (prev !== code && safety < 20) {
        prev = code;
        safety++;
        code = code.replace(/\(\s*(\d+)\s*\+\s*(\d+)\s*\)/g, function(match, a, b) {
            return String(Number(a) + Number(b));
        });
        code = code.replace(/\b(\d+)\s*\+\s*(\d+)\b/g, function(match, a, b) {
            const r = Number(a) + Number(b);
            return r < 100000 ? String(r) : match;
        });
    }
    return code;
}

function applyVarMap(code, map) {
    const keys = Object.keys(map);
    for (let i = 0; i < keys.length; i++) {
        const v = keys[i];
        const name = map[v];
        code = code.replace(new RegExp('\\b' + v + '\\b', 'g'), name);
    }
    return code;
}

function genericStrings(code) {
    const s = new Set();
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(code)) !== null) {
        const v = m[1] || m[2];
        if (v && v.length > 1) s.add(v);
    }
    return Array.from(s);
}

function escStr(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function reconstructLOL(strings, numbers) {
    const L = [];
    const urls = strings.filter(function(s) { return /^https?:\/\//i.test(s); });
    const svcList = ['Players','RunService','UserInputService','TweenService',
                     'HttpService','ReplicatedStorage','Workspace','Lighting']
                    .filter(function(s) { return strings.includes(s); });

    L.push('--[[');
    L.push('  كود Roblox المُفكّ -- LuaDecrypt');
    L.push('  ' + strings.length + ' ثابت نصي -- ' + urls.length + ' رابط');
    L.push(']]');
    L.push('');

    if (svcList.length > 0) {
        L.push('-- الخدمات');
        svcList.forEach(function(s) {
            L.push('local ' + s + ' = game:GetService("' + s + '")');
        });
        L.push('');
    }

    if (strings.includes('LocalPlayer') || strings.includes('Players')) {
        L.push('-- اللاعب');
        L.push('local Players = game:GetService("Players")');
        L.push('local LocalPlayer = Players.LocalPlayer');
        L.push('');
    }

    if (urls.length > 0) {
        L.push('-- الروابط المكتشفة');
        urls.forEach(function(u, i) {
            L.push('-- [' + (i+1) + '] ' + u);
        });
        L.push('');
    }

    L.push('-- جميع الثوابت المستخرجة');
    strings.filter(function(s) { return s.length > 1; }).forEach(function(s, i) {
        L.push('-- [' + String(i).padStart(3,'0') + '] "' + escStr(s) + '"');
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
            urls = strings.filter(function(s) { return /^https?:\/\//i.test(s); });
            result = reconstructLOL(strings, numbers);
        } else {
            strings = genericStrings(code);
            urls = strings.filter(function(s) { return /^https?:\/\//i.test(s); });
            result = '-- [[ LuaDecrypt -- فك عام ]]\n\n' + applyVarMap(simplMath(code), varMap);
        }
    } else {
        strings = genericStrings(code);
        urls = strings.filter(function(s) { return /^https?:\/\//i.test(s); });
        result = '-- [[ LuaDecrypt -- فك عام ]]\n\n' + applyVarMap(simplMath(code), varMap);
    }

    return { result: result, type: type, strings: strings, urls: urls };
}

client.once('ready', function() {
    console.log('البوت شغال: ' + client.user.tag);
});

client.on('messageCreate', async function(message) {
    if (message.author.bot) return;

    if (message.content === '.help') {
        return message.reply(
            '**أوامر البوت:**\n\n' +
            '`.d` + رابط: فك تشفير من رابط\n' +
            '`.d` + ملف `.lua`: فك تشفير ملف\n' +
            '`.d` + كود بين كود: فك تشفير مباشر'
        );
    }

    if (message.content.startsWith('.d')) {
        let code = '';
        let loadMsg = await message.reply('جاري المعالجة...');

        try {
            if (message.content.includes('http')) {
                const url = message.content.split(' ')[1];
                await loadMsg.edit('جاري تحميل الرابط...');
                const res = await axios.get(url, { timeout: 10000 });
                code = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

            } else if (message.attachments.size > 0) {
                const file = message.attachments.first();
                if (!file.name.endsWith('.lua') && !file.name.endsWith('.txt')) {
                    return loadMsg.edit('الملف لازم يكون .lua أو .txt');
                }
                await loadMsg.edit('جاري قراءة الملف...');
                const res = await axios.get(file.url);
                code = res.data;

            } else {
                const match = message.content.match(/```(?:lua)?\n?([\s\S]+?)```/);
                if (match) code = match[1];
            }

            if (!code) {
                return loadMsg.edit('ما لقيت كود! اكتب .help للمساعدة');
            }

            await loadMsg.edit('جاري فك التشفير...');

            const deobf = deobfuscate(code);
            const result = deobf.result;
            const type = deobf.type;
            const strings = deobf.strings;
            const urls = deobf.urls;

            const statsText = '\nالنوع: ' + type +
                ' | الثوابت: ' + strings.length +
                ' | الروابط: ' + urls.length;

            const urlsText = urls.length > 0
                ? '\nروابط مكتشفة:\n' + urls.map(function(u) { return '> ' + u; }).join('\n')
                : '';

            if (result.length < 1800) {
                await loadMsg.edit(
                    'تم فك التشفير:' + statsText + urlsText + '\n' +
                    '```lua\n' + result.slice(0, 1700) + '\n```'
                );
            } else {
                const buffer = Buffer.from(result, 'utf8');
                const attachment = new AttachmentBuilder(buffer, { name: 'deobfuscated.lua' });
                await loadMsg.delete();
                await message.reply({
                    content: 'تم فك التشفير' + statsText + urlsText,
                    files: [attachment]
                });
            }

        } catch (err) {
            console.error(err);
            await loadMsg.edit('صار خطأ: ' + err.message);
        }
    }
});

client.login(TOKEN);
