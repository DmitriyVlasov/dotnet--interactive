// Copyright (c) .NET Foundation and contributors. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

import { AddressInfo, createServer } from "net";
import * as cp from 'child_process';
import {
    DisposableSubscription,
    KernelCommand,
    KernelCommandType,
    KernelEventEnvelope,
    KernelEventEnvelopeObserver,
    DiagnosticLogEntryProducedType,
    DiagnosticLogEntryProduced,
    KernelReadyType
} from "./contracts";
import { ProcessStart } from './interfaces';
import { ReportChannel } from './interfaces/vscode';
import { LineReader } from './lineReader';
import { parse, stringify } from './utilities';

export class StdioKernelTransport {
    private childProcess: cp.ChildProcessWithoutNullStreams | null;
    private lineReader: LineReader;
    private readyPromise: Promise<void>;
    private subscribers: Array<KernelEventEnvelopeObserver> = [];
    public httpPort: Number;

    constructor(processStart: ProcessStart, private diagnosticChannel: ReportChannel) {
        // prepare root event handler
        this.lineReader = new LineReader();
        this.lineReader.subscribe(line => this.handleLine(line));
        this.childProcess = null;
        this.httpPort = 0;

        // prepare one-time ready event
        this.readyPromise = new Promise<void>(async (resolve, reject) => {

            let args = await this.configureHttpArgs(processStart.args);
            // launch the process
            let childProcess = cp.spawn(processStart.command, args, { cwd: processStart.workingDirectory });
            let pid = childProcess.pid;

            this.childProcess = childProcess;
            this.diagnosticChannel.appendLine(`Kernel started with pid ${childProcess.pid}.`);

            childProcess.on('exit', (code: number, signal: string) => {

                let message = `Kernel pid ${childProcess.pid} ended`;
                let messageCodeSuffix = (code && code !== 0)
                    ? ` with code ${code}`
                    : '';
                let messageSignalSuffix = signal
                    ? ` with signal ${signal}`
                    : '';
                this.diagnosticChannel.appendLine(message + messageCodeSuffix + messageSignalSuffix);
            });

            childProcess.stdout.on('data', data => this.lineReader.onData(data));
            childProcess.stderr.on('data', data => this.diagnosticChannel.appendLine(`kernel (${pid}) stderr: ${data.toString('utf-8')}`));


            const readySubscriber = this.subscribeToKernelEvents(eventEnvelope => {
                if (eventEnvelope.eventType === KernelReadyType) {
                    readySubscriber.dispose();
                    resolve();
                }
            });
        });
    }

    private async configureHttpArgs(args: string[]): Promise<string[]> {
        let newArgs = [...args];
        let index = newArgs.indexOf("--http-port");
        if (index < 0) {
            index = newArgs.indexOf("--http-port-range");
            this.httpPort = await this.findFreePort();

            if (index > 0) {
                this.diagnosticChannel.appendLine("the --http-port-range command option is not supported in vscode extension, remove if from settings. The kernel will start with --http-port option isntead.");
                newArgs[index] = "--http-port";
                newArgs[index + 1] = `${this.httpPort}`;
            } else {
                newArgs.push("--http-port");
                newArgs.push(`${this.httpPort}`);
            }
        } else {
            this.httpPort = parseInt(newArgs[index + 1]);
        }

        return newArgs;
    }

    private findFreePort(): Promise<number> {
        return new Promise<number>((resolve, reject) => {
            const server = createServer();
            let port: number;
            server.once("listening", () => {
                const address = server.address() as AddressInfo;
                port = address.port;
                server.close();
            });
            server.once("close", () => {
                if (typeof port === "undefined") {
                    reject("Can't get port");
                    return;
                }
                resolve(port);
            });
            server.once("error", reject);
            server.listen(0, "127.0.0.1");
        });
    }

    private isNotNull<T>(obj: T | null): obj is T {
        return obj !== undefined;
    }

    private handleLine(line: string) {
        let obj = parse(line);
        let envelope = <KernelEventEnvelope>obj;
        switch (envelope.eventType) {
            case DiagnosticLogEntryProducedType:
                this.diagnosticChannel.appendLine((<DiagnosticLogEntryProduced>envelope.event).message);
                break;
        }

        for (let i = this.subscribers.length - 1; i >= 0; i--) {
            this.subscribers[i](envelope);
        }
    }

    subscribeToKernelEvents(observer: KernelEventEnvelopeObserver): DisposableSubscription {
        this.subscribers.push(observer);
        return {
            dispose: () => {
                let i = this.subscribers.indexOf(observer);
                if (i >= 0) {
                    this.subscribers.splice(i, 1);
                }
            }
        };
    }

    submitCommand(command: KernelCommand, commandType: KernelCommandType, token: string): Promise<void> {
        return new Promise((resolve, reject) => {
            let submit = {
                token,
                commandType,
                command
            };

            let str = stringify(submit);
            if (this.isNotNull(this.childProcess)) {
                this.childProcess.stdin.write(str);
                this.childProcess.stdin.write('\n');

                resolve();
            }
            else {
                reject();
            }
        });
    }

    waitForReady(): Promise<void> {
        return this.readyPromise;
    }

    dispose() {
        if (this.isNotNull(this.childProcess)) {
            this.childProcess.kill();
        }
    }
}
