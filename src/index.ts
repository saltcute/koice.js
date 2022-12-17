import axios from 'axios';
import ws from 'websocket';
import fs from 'fs';
import crypto from 'crypto';
import upath from 'upath';
import ffmpeg from 'fluent-ffmpeg';
import delay from 'delay';
import { exec } from 'child_process';

import { Readable as ReadableStream } from "stream";

export default class koice {
    token: string;
    rtpURL: string = "";
    haveURL: boolean = false;
    // channelId: string;
    constructor(tk: string) {
        this.token = tk;
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
    /**
     * Start streaming audio in the voice chat
     * @param stream readable stream or path to the audio file
     * @param binary path to ffmpeg binary
     */
    async startStream(stream: ReadableStream | string, binary?: string): Promise<void> {
        while (!this.haveURL) {
            await delay(100);
        }
        if (binary) ffmpeg.setFfmpegPath(binary);
        ffmpeg()
            .input(stream)
            .outputOption([
                '-map 0:a'
            ])
            .withNativeFramerate()
            .audioCodec('libopus')
            .audioBitrate('128k')
            .audioChannels(2)
            .audioFrequency(48000)
            .outputFormat('tee')
            .save(`[select=a:f=rtp:ssrc=1357:payload_type=100]${this.rtpURL}`)
    }
    async connectWebSocket(channelId: string): Promise<void> {
        const gateway = await this.getGateway(channelId);
        const msgJSON = JSON.parse(fs.readFileSync(upath.toUnix(upath.join(__dirname, "msg.json")), { encoding: "utf-8", flag: "r" }));
        var ip: string, port: string, rtcpPort: string;
        // console.log(gateway);
        const client = new ws.client();
        client.on('connect', (connection) => {
            console.log("WebSocket connected");
            connection.send(JSON.stringify(msgJSON[1]));
            var current: number = 1;
            setInterval(() => {
                connection.ping("");
            }, 30 * 1000)
            connection.on('message', (message) => {
                if (message.type == "utf8") {
                    // console.log(message);
                    const data = JSON.parse(message.utf8Data);
                    console.log(`${current}: `);
                    console.dir(data, { depth: null });
                    console.log("");
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
                            console.log("The connection was disconnected");
                            // client.
                        }
                    }
                }
            });
            connection.on('close', () => {
                console.log("Connection closed");
            })
            connection.on('error', (err) => {
                throw err;
            })
        })
        client.on('connectFailed', (err) => {
            throw err;
        })
        client.connect(gateway);
    }
}