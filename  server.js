const express = require('express');
const { Server } = require('socket.io');
const http = require('http');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const fs = require('fs-extra');
const pino = require('pino');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = './auth_info';

let sock = null;
let pairingCode = null;
let isConnected = false;

// ==================== BAILEYS SETUP ====================

async function connectToWhatsApp(socket) {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        generateHighQualityLinkPreview: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrImage = await QRCode.toDataURL(qr);
            socket.emit('qr', qrImage);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            isConnected = false;
            socket.emit('status', { connected: false, message: 'Disconnected' });
            if (shouldReconnect) setTimeout(() => connectToWhatsApp(socket), 5000);
        } else if (connection === 'open') {
            isConnected = true;
            pairingCode = null;
            socket.emit('status', { 
                connected: true, 
                message: 'Connected!',
                user: sock.user 
            });
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            handleIncomingMessage(msg, socket);
        }
    });

    return sock;
}

// ==================== BUTTONS & MESSAGES ====================

// إرسال رسالة نصية عادية
async function sendTextMessage(to, text) {
    if (!sock || !isConnected) return false;
    try {
        await sock.sendMessage(to, { text: text });
        return true;
    } catch (error) {
        console.error('Error sending text:', error);
        return false;
    }
}

// إرسال أزرار تفاعلية (Buttons)
async function sendButtonsMessage(to, text, buttons, footer = '') {
    if (!sock || !isConnected) return false;
    try {
        // تنسيق الأزرار لـ Baileys
        const formattedButtons = buttons.map((btn, index) => ({
            buttonId: btn.id || `btn_${index}`,
            buttonText: { displayText: btn.text },
            type: 1
        }));

        await sock.sendMessage(to, {
            text: text,
            footer: footer,
            buttons: formattedButtons,
            headerType: 1
        });
        console.log('✅ Buttons sent to', to);
        return true;
    } catch (error) {
        console.error('❌ Error sending buttons:', error);
        // fallback: إرسال نص عادي إذا فشلت الأزرار
        const fallbackText = text + '\n\n' + buttons.map(b => `• ${b.text}`).join('\n');
        await sendTextMessage(to, fallbackText);
        return false;
    }
}

// إرسال قائمة منسدلة (List Message)
async function sendListMessage(to, title, text, sections, footer = '') {
    if (!sock || !isConnected) return false;
    try {
        await sock.sendMessage(to, {
            text: text,
            footer: footer,
            title: title,
            buttonText: "اختر من القائمة",
            sections: sections
        });
        console.log('✅ List sent to', to);
        return true;
    } catch (error) {
        console.error('❌ Error sending list:', error);
        return false;
    }
}

// إرسال قالب HTML (Template Message)
async function sendTemplateMessage(to, templateParams) {
    if (!sock || !isConnected) return false;
    try {
        await sock.sendMessage(to, {
            templateMessage: {
                hydratedTemplate: {
                    hydratedContentText: templateParams.text,
                    hydratedFooterText: templateParams.footer || '',
                    hydratedButtons: templateParams.buttons || []
                }
            }
        });
        return true;
    } catch (error) {
        console.error('❌ Error sending template:', error);
        return false;
    }
}

// ==================== MESSAGE HANDLER ====================

async function handleIncomingMessage(msg, socket) {
    const sender = msg.key.remoteJid;
    const text = msg.message?.conversation || 
                 msg.message?.extendedTextMessage?.text || 
                 msg.message?.buttonsResponseMessage?.selectedButtonId ||
                 msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId || '';

    const displayText = msg.message?.conversation || 
                       msg.message?.extendedTextMessage?.text ||
                       msg.message?.buttonsResponseMessage?.selectedDisplayText ||
                       msg.message?.listResponseMessage?.title || '';

    console.log(`💬 From ${sender}: ${displayText} (ID: ${text})`);

    // إرسال للواجهة
    socket.emit('new-message', {
        from: sender,
        text: displayText,
        rawId: text,
        timestamp: new Date().toISOString()
    });

    // معالجة الردود
    await processResponse(sender, text, displayText, socket);
}

async function processResponse(to, buttonId, displayText, socket) {
    let replyText = '';
    let buttons = [];
    let sendAsButtons = false;
    let sendAsList = false;
    let listSections = [];

    // الرد على الأزرار
    switch(buttonId) {
        case 'menu_main':
        case 'menu':
        case 'مرحبا':
        case 'اهلا':
            replyText = '👋 *أهلاً وسهلاً!*\nاختر الخدمة التي تريدها:';
            buttons = [
                { id: 'services', text: '🛍️ الخدمات' },
                { id: 'prices', text: '💰 الأسعار' },
                { id: 'support', text: '📞 الدعم الفني' },
                { id: 'info', text: 'ℹ️ معلومات' }
            ];
            sendAsButtons = true;
            break;

        case 'services':
        case 'خدمات':
            replyText = '🛍️ *خدماتنا المتاحة:*\nاختر الخدمة للتفاصيل:';
            buttons = [
                { id: 'service_bot', text: '🤖 بوت واتساب' },
                { id: 'service_web', text: '🌐 موقع إلكتروني' },
                { id: 'service_app', text: '📱 تطبيق موبايل' },
                { id: 'menu_main', text: '🔙 رجوع للقائمة' }
            ];
            sendAsButtons = true;
            break;

        case 'prices':
        case 'اسعار':
        case 'سعر':
            replyText = '💰 *باقات الأسعار:*\nاختر الباقة المناسبة:';
            // استخدام قائمة منسدلة للأسعار (أفضل للخيارات الكثيرة)
            listSections = [{
                title: "الباقات المتاحة",
                rows: [
                    { title: "الباقة الأساسية", rowId: "price_basic", description: "50 ريال/شهر - بوت أساسي" },
                    { title: "الباقة المتوسطة", rowId: "price_pro", description: "100 ريال/شهر - بوت + موقع" },
                    { title: "الباقة الكاملة", rowId: "price_enterprise", description: "200 ريال/شهر - كل شيء + دعم 24/7" },
                    { title: "باقة مخصصة", rowId: "price_custom", description: "تواصل معنا للتفاصيل" }
                ]
            }];
            sendAsList = true;
            break;

        case 'price_basic':
            replyText = '✨ *الباقة الأساسية - 50 ريال/شهر*\n\n• بوت واتساب أساسي\n• ردود آلية\n• تقارير يومية\n• دعم فني عبر البريد\n\nهل تريد الاشتراك؟';
            buttons = [
                { id: 'subscribe_basic', text: '✅ اشتراك' },
                { id: 'prices', text: '🔙 رجوع' }
            ];
            sendAsButtons = true;
            break;

        case 'price_pro':
            replyText = '⭐ *الباقة المتوسطة - 100 ريال/شهر*\n\n• كل ميزات الأساسية\n• موقع إلكتروني بسيط\n• تخصيص كامل للبوت\n• تقارير متقدمة\n• دعم فني واتساب\n\nهل تريد الاشتراك؟';
            buttons = [
                { id: 'subscribe_pro', text: '✅ اشتراك' },
                { id: 'prices', text: '🔙 رجوع' }
            ];
            sendAsButtons = true;
            break;

        case 'price_enterprise':
            replyText = '🏆 *الباقة الكاملة - 200 ريال/شهر*\n\n• كل ميزات المتوسطة\n• تطبيق موبايل\n• API كامل\n• دعم فني 24/7\n• استضافة مجانية\n\nهل تريد الاشتراك؟';
            buttons = [
                { id: 'subscribe_enterprise', text: '✅ اشتراك' },
                { id: 'prices', text: '🔙 رجوع' }
            ];
            sendAsButtons = true;
            break;

        case 'subscribe_basic':
        case 'subscribe_pro':
        case 'subscribe_enterprise':
            const plan = buttonId.replace('subscribe_', '');
            replyText = `🎉 *تم اختيار الباقة!*\n\nPlan: ${plan}\n\nسنتواصل معك خلال 24 ساعة لإتمام الاشتراك.\n\nرقم طلبك: #${Math.floor(Math.random() * 10000)}`;
            buttons = [
                { id: 'menu_main', text: '🏠 القائمة الرئيسية' },
                { id: 'support', text: '📞 تواصل معنا' }
            ];
            sendAsButtons = true;
            break;

        case 'support':
        case 'دعم':
            replyText = '📞 *الدعم الفني*\n\nكيف يمكننا مساعدتك؟';
            buttons = [
                { id: 'support_chat', text: '💬 دردشة مباشرة' },
                { id: 'support_call', text: '📞 اتصال' },
                { id: 'support_email', text: '📧 بريد إلكتروني' },
                { id: 'menu_main', text: '🔙 رجوع' }
            ];
            sendAsButtons = true;
            break;

        case 'support_chat':
            replyText = '💬 *الدردشة المباشرة*\n\nتم إخطار فريق الدعم. سيتواصل معك أحد المختصين قريباً.\n\n⏰ أوقات الدعم: 9 ص - 9 م';
            buttons = [{ id: 'menu_main', text: '🏠 القائمة الرئيسية' }];
            sendAsButtons = true;
            break;

        case 'support_call':
            replyText = '📞 *الاتصال الهاتفي*\n\nرقم الدعم: 9200XXXXX\n\n⏰ أوقات العمل:\nالسبت - الخميس: 9 ص - 6 م';
            buttons = [{ id: 'menu_main', text: '🏠 القائمة الرئيسية' }];
            sendAsButtons = true;
            break;

        case 'support_email':
            replyText = '📧 *البريد الإلكتروني*\n\nsupport@example.com\n\nيرجى إرفاق رقم العميل في الموضوع.';
            buttons = [{ id: 'menu_main', text: '🏠 القائمة الرئيسية' }];
            sendAsButtons = true;
            break;

        case 'info':
        case 'معلومات':
            replyText = 'ℹ️ *معلومات عنا*\n\nنحن شركة متخصصة في:\n• تطوير بوتات واتساب\n• المواقع الإلكترونية\n• تطبيقات الموبايل\n\n📍 الموقع: الرياض، السعودية\n🌐 الموقع: www.example.com';
            buttons = [
                { id: 'menu_main', text: '🔙 رجوع للقائمة' }
            ];
            sendAsButtons = true;
            break;

        case 'service_bot':
            replyText = '🤖 *بوت واتساب*\n\nبوت ذكي يتعامل مع:\n• الردود الآلية\n• الحجوزات\n• المدفوعات\n• التقارير\n\nالسعر يبدأ من 50 ريال/شهر';
            buttons = [
                { id: 'prices', text: '💰 الأسعار' },
                { id: 'services', text: '🔙 رجوع' }
            ];
            sendAsButtons = true;
            break;

        case 'service_web':
            replyText = '🌐 *موقع إلكتروني*\n\n• تصميم احترافي\n• متوافق مع الجوال\n• SEO محسن\n• لوحة تحكم سهلة\n\nالسعر يبدأ من 500 ريال';
            buttons = [
                { id: 'prices', text: '💰 الأسعار' },
                { id: 'services', text: '🔙 رجوع' }
            ];
            sendAsButtons = true;
            break;

        case 'service_app':
            replyText = '📱 *تطبيق موبايل*\n\n• iOS & Android\n• تصميم عصري\n• أداء عالي\n• دعم مستمر\n\nالسعر يبدأ من 5000 ريال';
            buttons = [
                { id: 'prices', text: '💰 الأسعار' },
                { id: 'services', text: '🔙 رجوع' }
            ];
            sendAsButtons = true;
            break;

        default:
            // رسالة ترحيبية أولى
            replyText = '👋 *مرحباً!*\n\nأنا بوت الخدمة الذكي. كيف يمكنني مساعدتك؟';
            buttons = [
                { id: 'menu_main', text: '📋 القائمة الرئيسية' },
                { id: 'services', text: '🛍️ خدماتنا' },
                { id: 'support', text: '📞 دعم فني' }
            ];
            sendAsButtons = true;
    }

    // إرسال الرد
    if (sendAsList) {
        await sendListMessage(to, "اختر خياراً", replyText, listSections, "اضغط على الزر أدناه");
    } else if (sendAsButtons) {
        await sendButtonsMessage(to, replyText, buttons, "اختر من الأزرار أدناه");
    } else {
        await sendTextMessage(to, replyText);
    }

    // إرسال للواجهة
    socket.emit('bot-reply', {
        to: to,
        text: replyText,
        buttons: sendAsButtons ? buttons : null,
        timestamp: new Date().toISOString()
    });
}

// ==================== PAIRING CODE ====================

async function generatePairingCode(phoneNumber, socket) {
    if (!sock) await connectToWhatsApp(socket);
    
    setTimeout(async () => {
        try {
            if (sock && sock.requestPairingCode) {
                const code = await sock.requestPairingCode(phoneNumber);
                pairingCode = code;
                socket.emit('pairing-code', code);
            }
        } catch (error) {
            socket.emit('error', 'Failed to generate pairing code');
        }
    }, 3000);
}

// ==================== EXPRESS ROUTES ====================

app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Bot - مع الأزرار</title>
        <script src="/socket.io/socket.io.js"></script>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
            }
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                max-width: 900px;
                width: 100%;
            }
            h1 { color: #333; margin-bottom: 10px; font-size: 28px; text-align: center; }
            .subtitle { color: #666; margin-bottom: 30px; text-align: center; }
            
            .grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 30px;
            }
            
            @media (max-width: 768px) {
                .grid { grid-template-columns: 1fr; }
            }
            
            .panel {
                background: #f8f9fa;
                border-radius: 15px;
                padding: 25px;
            }
            
            .panel h2 {
                color: #667eea;
                margin-bottom: 20px;
                font-size: 20px;
                border-bottom: 2px solid #667eea;
                padding-bottom: 10px;
            }
            
            .input-group { margin-bottom: 20px; }
            label {
                display: block;
                margin-bottom: 8px;
                color: #555;
                font-weight: 600;
                font-size: 14px;
            }
            input, textarea, select {
                width: 100%;
                padding: 12px;
                border: 2px solid #e0e0e0;
                border-radius: 8px;
                font-size: 14px;
                transition: border-color 0.3s;
                font-family: inherit;
            }
            input:focus, textarea:focus, select:focus {
                outline: none;
                border-color: #667eea;
            }
            
            button {
                width: 100%;
                padding: 12px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 16px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.3s;
                margin-bottom: 10px;
            }
            button:hover {
                transform: translateY(-2px);
                box-shadow: 0 5px 20px rgba(102, 126, 234, 0.4);
            }
            button.secondary {
                background: #6c757d;
            }
            button.success {
                background: #28a745;
            }
            button.danger {
                background: #dc3545;
            }
            button:disabled {
                opacity: 0.6;
                cursor: not-allowed;
                transform: none;
            }
            
            .status-box {
                margin-top: 20px;
                padding: 15px;
                border-radius: 10px;
                display: none;
                text-align: center;
            }
            .status-box.active { display: block; }
            .status-box.loading { background: #fff3cd; color: #856404; }
            .status-box.success { background: #d4edda; color: #155724; }
            .status-box.error { background: #f8d7da; color: #721c24; }
            
            .pairing-code {
                font-size: 36px;
                font-weight: bold;
                letter-spacing: 8px;
                color: #667eea;
                margin: 15px 0;
                font-family: monospace;
            }
            
            .messages-box {
                max-height: 400px;
                overflow-y: auto;
                background: white;
                border-radius: 10px;
                padding: 15px;
            }
            
            .message {
                background: white;
                border-right: 4px solid #667eea;
                padding: 12px;
                margin-bottom: 12px;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                position: relative;
            }
            .message.incoming { border-right-color: #28a745; }
            .message.outgoing { border-right-color: #667eea; }
            
            .message-header {
                display: flex;
                justify-content: space-between;
                margin-bottom: 5px;
                font-size: 12px;
            }
            .message-from { font-weight: bold; color: #667eea; }
            .message-time { color: #999; }
            .message-text { color: #333; line-height: 1.5; margin: 8px 0; }
            
            .message-buttons {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-top: 10px;
            }
            .msg-btn {
                background: #e3f2fd;
                color: #1976d2;
                padding: 6px 12px;
                border-radius: 20px;
                font-size: 12px;
                border: 1px solid #90caf9;
            }
            
            .preview-box {
                background: #e8f5e9;
                border: 2px dashed #4caf50;
                border-radius: 10px;
                padding: 20px;
                margin-top: 15px;
                text-align: center;
                display: none;
            }
            .preview-box.active { display: block; }
            
            .button-tag {
                display: inline-block;
                background: #667eea;
                color: white;
                padding: 4px 12px;
                border-radius: 15px;
                font-size: 12px;
                margin: 5px;
            }
            
            .instructions {
                background: #e3f2fd;
                padding: 15px;
                border-radius: 10px;
                margin-top: 15px;
                font-size: 13px;
                line-height: 1.8;
            }
            .instructions ol { padding-right: 20px; }
            
            .stats {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 10px;
                margin-bottom: 20px;
            }
            .stat-box {
                background: white;
                padding: 15px;
                border-radius: 10px;
                text-align: center;
                box-shadow: 0 2px 5px rgba(0,0,0,0.05);
            }
            .stat-number {
                font-size: 24px;
                font-weight: bold;
                color: #667eea;
            }
            .stat-label {
                font-size: 12px;
                color: #666;
                margin-top: 5px;
            }
            
            .quick-actions {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 10px;
                margin-top: 15px;
            }
            
            .typing-indicator {
                display: none;
                color: #667eea;
                font-size: 14px;
                margin-top: 10px;
            }
            .typing-indicator.active { display: block; }
            
            .spinner {
                display: inline-block;
                width: 16px;
                height: 16px;
                border: 2px solid rgba(255,255,255,.3);
                border-radius: 50%;
                border-top-color: white;
                animation: spin 1s ease-in-out infinite;
                margin-left: 8px;
            }
            @keyframes spin { to { transform: rotate(360deg); } }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>🤖 بوت واتساب المتقدم</h1>
            <p class="subtitle">مع ميزة الأزرار التفاعلية والقوائم المنسدلة</p>
            
            <div class="grid">
                <!-- Panel 1: Connection -->
                <div class="panel">
                    <h2>🔗 الاتصال</h2>
                    
                    <div class="input-group">
                        <label>📱 رقم الهاتف (مع رمز الدولة)</label>
                        <input type="text" id="phone" placeholder="9665XXXXXXXX" value="966">
                    </div>
                    
                    <button id="connectBtn" onclick="connect()">
                        <span id="btnText">الحصول على Pairing Code</span>
                    </button>
                    
                    <div id="statusBox" class="status-box"></div>
                    
                    <div class="instructions" id="instructions" style="display: none;">
                        <strong>📋 خطوات الربط:</strong>
                        <ol>
                            <li>افتح واتساب → الإعدادات</li>
                            <li>الأجهزة المرتبطة → ربط جهاز</li>
                            <li>اختر "ربط برقم الهاتف"</li>
                            <li>أدخل الكود الظاهر</li>
                        </ol>
                    </div>
                    
                    <div class="stats" id="statsBox" style="display: none;">
                        <div class="stat-box">
                            <div class="stat-number" id="msgCount">0</div>
                            <div class="stat-label">الرسائل</div>
                        </div>
                        <div class="stat-box">
                            <div class="stat-number" id="replyCount">0</div>
                            <div class="stat-label">الردود</div>
                        </div>
                        <div class="stat-box">
                            <div class="stat-number" id="btnCount">0</div>
                            <div class="stat-label">الأزرار</div>
                        </div>
                    </div>
                </div>
                
                <!-- Panel 2: Send Message -->
                <div class="panel">
                    <h2>📤 إرسال رسالة</h2>
                    
                    <div class="input-group">
                        <label>📱 إلى (رقم الهاتف)</label>
                        <input type="text" id="sendTo" placeholder="9665XXXXXXXX">
                    </div>
                    
                    <div class="input-group">
                        <label>💬 نص الرسالة</label>
                        <textarea id="messageText" rows="3" placeholder="اكتب رسالتك هنا..."></textarea>
                    </div>
                    
                    <div class="input-group">
                        <label>🔘 نوع الرسالة</label>
                        <select id="messageType" onchange="toggleButtons()">
                            <option value="text">نص عادي</option>
                            <option value="buttons">أزرار تفاعلية</option>
                            <option value="list">قائمة منسدلة</option>
                        </select>
                    </div>
                    
                    <div id="buttonsSection" style="display: none;">
                        <div class="input-group">
                            <label>الأزرار (افصل بينها بفاصلة)</label>
                            <input type="text" id="buttonsInput" placeholder="نعم, لا, ربما, رجوع" value="خدماتنا, الأسعار, الدعم الفني">
                        </div>
                    </div>
                    
                    <div class="preview-box" id="previewBox">
                        <div id="previewContent"></div>
                    </div>
                    
                    <div class="quick-actions">
                        <button class="success" onclick="sendMessage()" id="sendBtn">📨 إرسال</button>
                        <button class="secondary" onclick="previewMessage()">👁️ معاينة</button>
                    </div>
                    
                    <div class="typing-indicator" id="typingIndicator">
                        <span class="spinner"></span> جاري الكتابة...
                    </div>
                </div>
            </div>
            
            <!-- Messages Panel -->
            <div class="panel" style="margin-top: 30px;">
                <h2>💬 الرسائل والتفاعلات</h2>
                <div class="messages-box" id="messagesBox">
                    <p style="text-align: center; color: #999; padding: 40px;">
                        لم تصل أي رسائل بعد. قم بالاتصال أولاً.
                    </p>
                </div>
                <button class="secondary" onclick="clearMessages()" style="margin-top: 15px; width: auto; padding: 10px 20px;">
                    🗑️ مسح السجل
                </button>
            </div>
        </div>

        <script>
            const socket = io();
            let messageStats = { received: 0, sent: 0, buttons: 0 };
            
            // UI Elements
            const phoneInput = document.getElementById('phone');
            const connectBtn = document.getElementById('connectBtn');
            const btnText = document.getElementById('btnText');
            const statusBox = document.getElementById('statusBox');
            const instructions = document.getElementById('instructions');
            const messagesBox = document.getElementById('messagesBox');
            const statsBox = document.getElementById('statsBox');
            
            function showStatus(type, text) {
                statusBox.className = 'status-box active ' + type;
                statusBox.innerHTML = text;
            }
            
            function connect() {
                const phone = phoneInput.value.trim();
                if (!phone || phone.length < 10) {
                    showStatus('error', '❌ الرجاء إدخال رقم صحيح');
                    return;
                }
                
                connectBtn.disabled = true;
                btnText.innerHTML = '<span class="spinner"></span> جاري الاتصال...';
                showStatus('loading', '⏳ جاري إنشاء Pairing Code...');
                
                socket.emit('request-pairing', phone);
            }
            
            function toggleButtons() {
                const type = document.getElementById('messageType').value;
                document.getElementById('buttonsSection').style.display = 
                    (type === 'buttons' || type === 'list') ? 'block' : 'none';
            }
            
            function previewMessage() {
                const type = document.getElementById('messageType').value;
                const text = document.getElementById('messageText').value || 'نص الرسالة';
                const buttons = document.getElementById('buttonsInput').value.split(',').filter(b => b.trim());
                
                let preview = '<strong>معاينة الرسالة:</strong><br><br>';
                preview += '<div style="background: white; padding: 15px; border-radius: 10px; text-align: right; margin: 10px 0;">';
                preview += '<div style="color: #333; margin-bottom: 10px;">' + text + '</div>';
                
                if (type === 'buttons' && buttons.length) {
                    preview += '<div style="display: flex; flex-wrap: wrap; gap: 5px;">';
                    buttons.forEach(btn => {
                        preview += '<span style="background: #667eea; color: white; padding: 5px 15px; border-radius: 15px; font-size: 12px;">' + btn.trim() + '</span>';
                    });
                    preview += '</div>';
                } else if (type === 'list') {
                    preview += '<div style="background: #f0f0f0; padding: 10px; border-radius: 5px; margin-top: 10px;">';
                    preview += '<small>📋 قائمة منسدلة (' + buttons.length + ' خيارات)</small>';
                    preview += '</div>';
                }
                
                preview += '</div>';
                
                document.getElementById('previewContent').innerHTML = preview;
                document.getElementById('previewBox').classList.add('active');
            }
            
            async function sendMessage() {
                const to = document.getElementById('sendTo').value.trim();
                const text = document.getElementById('messageText').value.trim();
                const type = document.getElementById('messageType').value;
                const buttonsInput = document.getElementById('buttonsInput').value;
                
                if (!to || !text) {
                    alert('الرجاء إدخال الرقم والرسالة');
                    return;
                }
                
                document.getElementById('sendBtn').disabled = true;
                document.getElementById('typingIndicator').classList.add('active');
                
                const buttons = buttonsInput.split(',').map((b, i) => ({
                    id: 'btn_' + i,
                    text: b.trim()
                })).filter(b => b.text);
                
                try {
                    const response = await fetch('/send-custom-message', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ to, text, type, buttons })
                    });
                    
                    const result = await response.json();
                    if (result.success) {
                        addMessageToBox({
                            from: 'أنت (Bot)',
                            text: text + (buttons.length ? ' [مع أزرار]' : ''),
                            type: 'outgoing',
                            timestamp: new Date().toISOString()
                        });
                        messageStats.sent++;
                        updateStats();
                        document.getElementById('messageText').value = '';
                    } else {
                        alert('فشل الإرسال: ' + result.error);
                    }
                } catch (error) {
                    alert('خطأ في الإرسال');
                }
                
                document.getElementById('sendBtn').disabled = false;
                document.getElementById('typingIndicator').classList.remove('active');
            }
            
            function addMessageToBox(msg) {
                const emptyMsg = messagesBox.querySelector('p');
                if (emptyMsg) emptyMsg.remove();
                
                const div = document.createElement('div');
                div.className = 'message ' + (msg.type || 'incoming');
                
                let buttonsHtml = '';
                if (msg.buttons && msg.buttons.length) {
                    buttonsHtml = '<div class="message-buttons">';
                    msg.buttons.forEach(btn => {
                        buttonsHtml += '<span class="msg-btn">' + btn.text + '</span>';
                    });
                    buttonsHtml += '</div>';
                    messageStats.buttons += msg.buttons.length;
                }
                
                div.innerHTML = 
                    '<div class="message-header">' +
                    '<span class="message-from">' + (msg.from || 'Unknown') + '</span>' +
                    '<span class="message-time">' + new Date(msg.timestamp).toLocaleString('ar-SA') + '</span>' +
                    '</div>' +
                    '<div class="message-text">' + msg.text + '</div>' +
                    buttonsHtml;
                
                messagesBox.insertBefore(div, messagesBox.firstChild);
                updateStats();
            }
            
            function updateStats() {
                document.getElementById('msgCount').textContent = messageStats.received;
                document.getElementById('replyCount').textContent = messageStats.sent;
                document.getElementById('btnCount').textContent = messageStats.buttons;
            }
            
            function clearMessages() {
                messagesBox.innerHTML = '<p style="text-align: center; color: #999; padding: 40px;">لم تصل أي رسائل بعد.</p>';
                messageStats = { received: 0, sent: 0, buttons: 0 };
                updateStats();
            }
            
            // Socket Events
            socket.on('pairing-code', (code) => {
                showStatus('success', 
                    '<div>✅ تم إنشاء الكود!</div>' +
                    '<div class="pairing-code">' + code + '</div>' +
                    '<div style="font-size: 13px; margin-top: 10px;">صالح لمدة 2 دقيقة</div>'
                );
                instructions.style.display = 'block';
                connectBtn.disabled = false;
                btnText.textContent = 'إعادة الاتصال';
            });
            
            socket.on('qr', (qrImage) => {
                showStatus('loading', '⏳ جاري انتظار QR Code...');
                instructions.style.display = 'none';
            });
            
            socket.on('status', (data) => {
                if (data.connected) {
                    showStatus('success', 
                        '<div>✅ متصل!</div>' +
                        '<div style="margin-top: 10px; font-size: 14px;">📱 ' + (data.user?.name || 'Bot') + '</div>'
                    );
                    instructions.style.display = 'none';
                    statsBox.style.display = 'grid';
                    connectBtn.style.display = 'none';
                    phoneInput.disabled = true;
                } else {
                    showStatus('error', '❌ ' + data.message);
                    connectBtn.disabled = false;
                    btnText.textContent = 'إعادة الاتصال';
                }
            });
            
            socket.on('new-message', (msg) => {
                messageStats.received++;
                addMessageToBox(msg);
            });
            
            socket.on('bot-reply', (msg) => {
                messageStats.sent++;
                addMessageToBox({
                    ...msg,
                    from: 'البوت (Auto)',
                    type: 'outgoing'
                });
            });
            
            socket.on('error', (msg) => {
                showStatus('error', '❌ ' + msg);
                connectBtn.disabled = false;
            });
            
            // Format inputs
            phoneInput.addEventListener('input', (e) => {
                e.target.value = e.target.value.replace(/[^0-9]/g, '');
            });
            document.getElementById('sendTo').addEventListener('input', (e) => {
                e.target.value = e.target.value.replace(/[^0-9]/g, '');
            });
        </script>
    </body>
    </html>
    `);
});

// API Routes
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        user: sock?.user || null,
        pairingCode: pairingCode
    });
});

// إرسال رسالة مخصصة مع أزرار
app.post('/send-custom-message', async (req, res) => {
    const { to, text, type, buttons } = req.body;
    
    if (!to || !text) {
        return res.status(400).json({ error: 'Missing to or text' });
    }
    
    const jid = to.includes('@') ? to : to + '@s.whatsapp.net';
    let result = false;
    
    try {
        if (type === 'buttons' && buttons && buttons.length > 0) {
            result = await sendButtonsMessage(jid, text, buttons);
        } else if (type === 'list' && buttons && buttons.length > 0) {
            const sections = [{
                title: "الخيارات المتاحة",
                rows: buttons.map((b, i) => ({
                    title: b.text,
                    rowId: b.id || `row_${i}`,
                    description: "اضغط للاختيار"
                }))
            }];
            result = await sendListMessage(jid, "اختر", text, sections);
        } else {
            result = await sendTextMessage(jid, text);
        }
        
        res.json({ success: result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== SOCKET.IO ====================

io.on('connection', (socket) => {
    console.log('🌐 Client connected:', socket.id);
    
    socket.emit('status', { 
        connected: isConnected, 
        user: sock?.user || null 
    });

    socket.on('request-pairing', async (phoneNumber) => {
        await generatePairingCode(phoneNumber, socket);
    });

    socket.on('disconnect', () => {
        console.log('🌐 Client disconnected:', socket.id);
    });
});

// ==================== START ====================

server.listen(PORT, () => {
    console.log(`
    ╔══════════════════════════════════════════════════╗
    ║  🤖 WhatsApp Bot with Buttons & Lists           ║
    ║  Running on port ${PORT}                           ║
    ╚══════════════════════════════════════════════════╝
    `);
});
