import WebSocket from 'ws';
import { EventEmitter } from 'events';

const blackListedEvents = ["CHANNEL_UNREAD_UPDATE", "CONVERSATION_SUMMARY_UPDATE", "SESSIONS_REPLACE"];
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const statusList = ["online", "idle", "dnd", "invisible", "offline"];

export class voiceClient extends EventEmitter {
    ws = null;
    heartbeatInterval;
    sequenceNumber = null;
    firstLoad = true;
    reconnectAttempts = 0;
    ignoreReconnect = false;
    reconnectTimeout;
    invalidSession = false;
    token;
    guildId;
    channelId;
    selfMute;
    selfDeaf;
    autoReconnect;
    presence;
    user_id = null;
    connected = false;

    constructor(config) {
        super();
        if (!config.token) {
            throw new Error('token, guildId, and channelId are required');
        }
        this.token = config.token;
        this.guildId = config?.serverId; // التصحيح هنا
        this.channelId = config?.channelId; // التصحيح هنا
        this.selfMute = config.selfMute ?? true; // التصحيح هنا
        this.selfDeaf = config.selfDeaf ?? true; // التصحيح هنا
        this.autoReconnect = {
            enabled: config.autoReconnect?.enabled ?? true,
            delay: (config.autoReconnect?.delay ?? 5) * 1000,
            maxRetries: config.autoReconnect?.maxRetries ?? 9999,
        };
        if (config?.presence?.status) {
            this.presence = config.presence;
        }
    }

    connect() {
        if (this.invalidSession) return;
        
        try {
            this.ws = new WebSocket(GATEWAY_URL, {
                skipUTF8Validation: true,
            });

            this.setMaxListeners(20);

            this.ws.on('open', () => {
                this.emit('connected');
                this.emit('debug', '🌐 Connected to Discord Gateway');
            });

            this.ws.on('message', (data) => {
                try {
                    const payload = JSON.parse(data.toString());
                    const { t: eventType, s: seq, op, d } = payload;
                    const isBlackListed = blackListedEvents.includes(eventType);
                    if (isBlackListed) return;

                    if (seq !== null) this.sequenceNumber = seq;

                    switch (op) {
                        case 10: // Hello
                            this.emit('debug', 'Received Hello (op 10)');
                            this.startHeartbeat(d.heartbeat_interval);
                            this.identify();
                            break;
                        case 11: // Heartbeat ACK
                            this.emit('debug', 'Heartbeat acknowledged');
                            break;
                        case 9: // Invalid Session
                            this.emit('debug', 'Invalid session. Reconnecting...');
                            this.invalidSession = true;
                            this.cleanup();
                            setTimeout(() => this.connect(), 5000);
                            break;
                        case 0: // Dispatch
                            if (eventType === 'READY') {
                                this.emit('ready', {
                                    username: d.user.username,
                                    discriminator: d.user.discriminator
                                });
                                this.emit('debug', `🎉 Logged in as ${d.user.username}#${d.user.discriminator}`);
                                this.user_id = d.user.id;
                                this.joinVoiceChannel();
                                this.sendStatusUpdate();
                            } else if (eventType === 'VOICE_STATE_UPDATE') {
                                if (d.user_id === this.user_id && d.channel_id === this.channelId && d?.guild_id === this.guildId && this.firstLoad) {
                                    this.emit('voiceReady');
                                    console.log('Voice channel joined successfully');
                                    this.emit('debug', 'Successfully joined voice channel');
                                    this.firstLoad = false;
                                } else if (d.user_id === this.user_id && (this.guildId && this.channelId && d?.channel_id !== this.channelId || d?.guild_id !== this.guildId)) {
                                    if (this.autoReconnect.enabled) {
                                        console.log('Received VOICE_STATE_UPDATE event, attempting to reconnect');
                                        if (this.ignoreReconnect) {
                                            console.log('Already reconnected, ignoring this event');
                                            return;
                                        };
                                        this.reconnectAttempts++;
                                        if (this.reconnectAttempts < this.autoReconnect.maxRetries) {
                                            if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                                            this.emit('debug', `Reconnecting... (${this.reconnectAttempts}/${this.autoReconnect.maxRetries})`);
                                            this.ignoreReconnect = true;
                                            this.reconnectTimeout = setTimeout(() => {
                                                this.joinVoiceChannel();
                                            }, this.autoReconnect.delay);
                                        } else {
                                            this.emit('debug', 'Max reconnect attempts reached. Stopping.');
                                            this.cleanup();
                                        }
                                    }
                                }
                            }
                            break;
                    }
                } catch (error) {
                    console.error('Error processing message:', error);
                }
            });

            this.ws.on('close', (code, reason) => {
                this.emit('disconnected');
                this.emit('debug', `❌ Disconnected. Code: ${code}, Reason: ${reason}`);
                this.cleanup();
                
                if (this.autoReconnect.enabled && this.reconnectAttempts < this.autoReconnect.maxRetries) {
                    setTimeout(() => this.connect(), 5000);
                }
            });

            this.ws.on('error', (err) => {
                this.emit('error', err);
                this.emit('debug', `WebSocket error: ${err.message}`);
            });

        } catch (error) {
            console.error('Connection error:', error);
            if (this.autoReconnect.enabled) {
                setTimeout(() => this.connect(), 5000);
            }
        }
    }

    startHeartbeat(interval) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 1, d: this.sequenceNumber }));
                this.emit('debug', 'Sending heartbeat');
            }
        }, interval);
    }

    identify() {
        const payload = {
            op: 2,
            d: {
                token: this.token,
                intents: 128,
                properties: {
                    os: 'Windows',
                    browser: 'Chrome',
                    device: ''
                },
            }
        };
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
            this.emit('debug', 'Sending identify payload');
        }
    }

    joinVoiceChannel() {
        if (!this.guildId || !this.channelId) return;
        const voiceStateUpdate = {
            op: 4,
            d: {
                guild_id: this.guildId,
                channel_id: this.channelId,
                self_mute: this.selfMute,
                self_deaf: this.selfDeaf
            }
        };
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(voiceStateUpdate));
            this.emit('debug', '🎤 Sent voice channel join request');
            setTimeout(() => {
                this.ignoreReconnect = false;
            }, 1000);
        }
    }

    cleanup() {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.heartbeatInterval = null;
        this.reconnectTimeout = null;
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }
            this.ws = null;
        }
        this.sequenceNumber = null;
        this.connected = false;
    }

    sendStatusUpdate() {
        const status = this?.presence?.status?.toLowerCase();
        if (!status || !statusList.includes(status)) return;
        const payload = {
            "op": 3,
            "d": {
                status: this.presence.status,
                activities: [],
                since: Math.floor(Date.now() / 1000) - 10,
                afk: true
            }
        };
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload));
            this.emit('debug', `Status updated to ${this.presence.status}`);
        }
    }

    disconnect() {
        this.autoReconnect.enabled = false;
        this.cleanup();
        this.emit('debug', 'Client manually disconnected');
    }
}
