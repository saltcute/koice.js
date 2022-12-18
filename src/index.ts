import axios from 'axios';
import * as ws from 'websocket';
import fs from 'fs';
import crypto from 'crypto';
import upath from 'upath';
import ffmpeg, { FfmpegCommand } from 'fluent-ffmpeg';
import delay from 'delay';
import { exec, ChildProcess } from 'child_process';

import { Readable as ReadableStream } from "stream";

export default class koice {
    token: string;

    rtpURL: string = "";
    haveURL: boolean = false;

    ffServer?: ChildProcess;
    isServer: boolean = false;
    zmqPort?: number;

    ffPath: string = "ffmpeg";

    ffStream?: FfmpegCommand;
    isStreaming: boolean = false;

    haveWSConnection: boolean = false;
    wsClient?: ws.client;
    wsConnection?: ws.connection;

    isClose: boolean = false;
    // channelId: string;
    constructor(tk: string, binary?: string) {
        this.token = tk;
        if (binary) this.ffPath = binary;
        ffmpeg.setFfmpegPath(this.ffPath);
    }
    async getrtpURL(): Promise<string> {
        while (!this.haveURL) {
            await delay(100);
        }
        return this.rtpURL;
    }
    async getGateway(channelId: string): Promise<string> {
        const res = await axios({
            url: "https://www.kookapp.cn/api/v3/gateway/voice",
            method: "GET",
            params: {
                channel_id: channelId
            },
            headers: {
                'Authorization': `Bot ${this.token}`
            }
        })
        // console.log(res);
        return res.data.data.gateway_url;
    }
    async startServer(): Promise<void> {
        while (!this.haveURL) {
            await delay(100);
        }
        if (this.isServer) {
            throw 'Server has already beem started';
        }
        this.isServer = true;
        this.zmqPort = await (await import('get-port')).default(({ port: 9514 }));
        this.ffServer = exec([
            this.ffPath,
            "-re",
            "-loglevel level+info",
            "-nostats",
            "-stream_loop",
            "-1",
            `-i "zmq:tcp://127.0.0.1:${this.zmqPort}"`,
            "-map 0:a:0",
            "-acodec libopus",
            "-ab 128k",
            "-ac 2",
            "-ar 48000",
            `-f tee "[select=a:f=rtp:ssrc=1357:payload_type=100]${this.rtpURL}"`
        ].join(" "));
    }
    async closeServer(): Promise<void> {
        if (this.ffServer) {
            this.ffServer.kill();
            this.ffServer = undefined;
        }
    }
    /**
     * Start streaming audio in the voice chat
     * @param stream readable stream or path to the audio file
     * @param binary path to ffmpeg binary
     */
    async startStream(stream: ReadableStream | string): Promise<void> {
        if (this.isStreaming) {
            throw 'Another stream is still active';
        }
        this.isStreaming = true;
        // console.log("===Start Playing===");
        if (this.isServer && this.zmqPort) {
            // console.log(this.zmqPort);
            this.ffStream = ffmpeg()
                .input(stream)
                .inputOption([
                    '-re',
                    '-nostats'
                ])
                .audioCodec('libopus')
                .audioBitrate('128k')
                .outputFormat('mpegts')
                .save(`zmq:tcp://127.0.0.1:${this.zmqPort}`)
                .on('end', () => {
                    this.isStreaming = false;
                });
        } else {
            while (!this.haveURL) {
                await delay(100);
            }
            this.ffStream = ffmpeg()
                .input(stream)
                .outputOption([
                    '-map 0:a:0'
                ])
                .withNativeFramerate()
                .audioCodec('libopus')
                .audioBitrate('128k')
                .audioChannels(2)
                .audioFrequency(48000)
                .outputFormat('tee')
                .save(`[select=a:f=rtp:ssrc=1357:payload_type=100]${this.rtpURL}`)
                .on('end', () => {
                    this.isStreaming = false;
                });
        }
    }
    async stopStream() {
        if (this.ffStream) {
            this.ffStream.kill("SIGKILL");
        }
        this.isStreaming = false;
    }
    async reset() {
        await this.close();
        this.rtpURL = "";
        this.haveURL = false;
        this.isServer = false;
        this.zmqPort = undefined
        this.ffPath = "ffmpeg";
        this.ffServer = undefined
        this.isStreaming = false;
    }
    async connectWebSocket(channelId: string): Promise<void> {
        const gateway = await this.getGateway(channelId);
        const msgJSON = JSON.parse(fs.readFileSync(upath.toUnix(upath.join(__dirname, "msg.json")), { encoding: "utf-8", flag: "r" }));
        var ip: string, port: string, rtcpPort: string;
        // console.log(gateway);
        this.wsClient = new ws.client();
        this.wsClient.on('connectFailed', (err) => {
            this.haveWSConnection = false;
            throw err;
        })
        this.wsClient.on('connect', (connection) => {
            this.haveWSConnection = true;
            this.wsConnection = connection;
            // console.log("WebSocket connected");
            connection.send(JSON.stringify(msgJSON[1]));
            var current: number = 1;
            setInterval(() => {
                connection.ping("");
            }, 30 * 1000)
            connection.on('message', (message) => {
                if (message.type == "utf8") {
                    // console.log(message);
                    const data = JSON.parse(message.utf8Data);
                    // console.log(`${current}: `);
                    // console.dir(data, { depth: null });
                    // console.log("");
                    if (current == 1) {
                        msgJSON[2].id = crypto.randomInt(1000000, 10000000);
                        // msgJSON[2].data.displayName = "PlayTest#1";
                        connection.send(JSON.stringify(msgJSON[2]));
                        current = 2;
                    } else if (current == 2) {
                        msgJSON[3].id = crypto.randomInt(1000000, 10000000);
                        connection.send(JSON.stringify(msgJSON[3]));
                        current = 3;
                    } else if (current == 3) {
                        const transportId = data.data.id;
                        ip = data.data.ip;
                        port = data.data.port;
                        rtcpPort = data.data.rtcpPort;
                        msgJSON[4].id = crypto.randomInt(1000000, 10000000);
                        msgJSON[4].data.transportId = transportId;
                        connection.send(JSON.stringify(msgJSON[4]));
                        current = 4;
                    } else if (current == 4) {
                        this.rtpURL = `rtp://${ip}:${port}?rtcpport=${rtcpPort}`;
                        this.haveURL = true;
                        current = 5;
                    }
                    else {
                        if (data.notification && data.method && data.method == "disconnect") {
                            this.disconnectWebSocket();
                        }
                    }
                }
            });
            connection.on('close', () => {
                this.haveWSConnection = false;
            })
            connection.on('error', (err) => {
                this.haveWSConnection = false;
                throw err;
            })
        })
        this.wsClient.on('connectFailed', (err) => {
            throw err;
        })
        this.wsClient.connect(gateway);
    }
    async disconnectWebSocket(): Promise<void> {
        var closed = false;
        if (this.wsConnection) {
            this.wsConnection.removeAllListeners();
            this.wsConnection.on('close', () => {
                this.wsConnection = undefined;
                closed = true;
            })
            this.wsConnection.close();
            while (!closed) {
                await delay(100);
            }
        }
        if (this.wsClient) {
            this.wsClient.removeAllListeners();
            this.wsClient = undefined;
        }
        this.haveWSConnection = false;
    }
    async close(): Promise<void> {
        await this.stopStream();
        await this.closeServer();
        await this.disconnectWebSocket();
    }
}