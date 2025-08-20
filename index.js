import { voiceClient } from "./client.js";
import tokens from "./tokens.js";
import express from 'express';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 5000;
let clients = [];

app.use(express.json());

app.get('/', (req, res) => {
    res.json({
        status: 'active',
        clients: clients.length,
        message: 'Discord Voice Client is running!'
    });
});

app.get('/status', (req, res) => {
    const status = clients.map(client => ({
        token: client.token.substring(0, 10) + '...',
        connected: client.connected,
        guildId: client.guildId,
        channelId: client.channelId
    }));
    res.json({ status });
});

// منع إيقاف الخدمة عند الأخطاء
process.on('uncaughtException', (err) => {
    console.error(`Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// بدء الخادم
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Server running on port ${port}`);
    initializeClients();
});

// تهيئة جميع العملاء
function initializeClients() {
    const cleanTokens = tokens.reduce((acc, token) => {
        // التصحيح هنا - إزالة المسافات بين ? و .
        const isValid = token?.token?.length > 30;
        const isDuplicate = acc.some(t => t.token === token.token);
        if (isValid && !isDuplicate) {
            acc.push(token);
        } else {
            console.warn('Invalid or duplicate token configuration:', token);
        }
        return acc;
    }, []);

    console.log(`Initializing ${cleanTokens.length} clients...`);

    // تهيئة العملاء مع تأخير بينهم لتجنب الحظر
    cleanTokens.forEach((token, index) => {
        setTimeout(() => {
            const client = new voiceClient(token);
            
            client.on('ready', (user) => {
                console.log(`[${index}] Logged in as ${user.username}#${user.discriminator}`);
                client.connected = true;
            });
            
            client.on('connected', () => {
                console.log(`[${index}] Connected to Discord`);
                client.connected = true;
            });
            
            client.on('disconnected', () => {
                console.log(`[${index}] Disconnected from Discord`);
                client.connected = false;
                
                // إعادة الاتصال التلقائي
                if (client.tokenConfig.autoReconnect.enabled) {
                    setTimeout(() => {
                        console.log(`[${index}] Attempting to reconnect...`);
                        client.connect();
                    }, client.tokenConfig.autoReconnect.delay * 1000);
                }
            });
            
            client.on('voiceReady', () => {
                console.log(`[${index}] Voice is ready`);
            });
            
            client.on('error', (error) => {
                console.error(`[${index}] Error:`, error.message);
            });
            
            client.on('debug', (message) => {
                console.debug(`[${index}] ${message}`);
            });
            
            // حفظ إعدادات التوكن في الكائن للرجوع إليها لاحقًا
            client.tokenConfig = token;
            client.connected = false;
            
            clients.push(client);
            client.connect();
        }, index * 2000); // تأخير 2 ثانية بين كل عميل لتجنب الحظر
    });
}

// إعادة تشغيل العميل عند فشله
function restartClient(index) {
    if (clients[index]) {
        console.log(`Restarting client ${index}...`);
        clients[index].connect();
    }
}

// إعادة تشغيل تلقائي لكل عميل كل ساعة (لضمان استمرارية الاتصال)
setInterval(() => {
    clients.forEach((client, index) => {
        if (!client.connected) {
            console.log(`Auto-restarting client ${index}...`);
            restartClient(index);
        }
    });
}, 60 * 60 * 1000); // كل ساعة

