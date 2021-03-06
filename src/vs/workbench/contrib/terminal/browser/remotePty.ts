/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Barrier } from 'vs/base/common/async';
import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { URI } from 'vs/base/common/uri';
import { ILogService } from 'vs/platform/log/common/log';
import { IProcessDataEvent, IShellLaunchConfig, ITerminalChildProcess, ITerminalDimensionsOverride, ITerminalLaunchError, TerminalShellType } from 'vs/platform/terminal/common/terminal';
import { IPtyHostProcessReplayEvent } from 'vs/platform/terminal/common/terminalProcess';
import { RemoteTerminalChannelClient } from 'vs/workbench/contrib/terminal/common/remoteTerminalChannel';
import { IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';

export class RemotePty extends Disposable implements ITerminalChildProcess {

	public readonly _onProcessData = this._register(new Emitter<string | IProcessDataEvent>());
	public readonly onProcessData: Event<string | IProcessDataEvent> = this._onProcessData.event;
	public readonly _onProcessBinary = this._register(new Emitter<string>());
	public readonly onProcessBinary: Event<string> = this._onProcessBinary.event;
	private readonly _onProcessExit = this._register(new Emitter<number | undefined>());
	public readonly onProcessExit: Event<number | undefined> = this._onProcessExit.event;
	public readonly _onProcessReady = this._register(new Emitter<{ pid: number, cwd: string }>());
	public get onProcessReady(): Event<{ pid: number, cwd: string }> { return this._onProcessReady.event; }
	private readonly _onProcessTitleChanged = this._register(new Emitter<string>());
	public readonly onProcessTitleChanged: Event<string> = this._onProcessTitleChanged.event;
	private readonly _onProcessShellTypeChanged = this._register(new Emitter<TerminalShellType | undefined>());
	public readonly onProcessShellTypeChanged = this._onProcessShellTypeChanged.event;
	private readonly _onProcessOverrideDimensions = this._register(new Emitter<ITerminalDimensionsOverride | undefined>());
	public readonly onProcessOverrideDimensions: Event<ITerminalDimensionsOverride | undefined> = this._onProcessOverrideDimensions.event;
	private readonly _onProcessResolvedShellLaunchConfig = this._register(new Emitter<IShellLaunchConfig>());
	public get onProcessResolvedShellLaunchConfig(): Event<IShellLaunchConfig> { return this._onProcessResolvedShellLaunchConfig.event; }

	private _startBarrier: Barrier;

	private _inReplay = false;

	public get id(): number { return this._id; }

	constructor(
		private _id: number,
		readonly shouldPersist: boolean,
		private readonly _remoteTerminalChannel: RemoteTerminalChannelClient,
		private readonly _remoteAgentService: IRemoteAgentService,
		private readonly _logService: ILogService
	) {
		super();
		this._startBarrier = new Barrier();
	}

	public async start(): Promise<ITerminalLaunchError | undefined> {
		// Fetch the environment to check shell permissions
		const env = await this._remoteAgentService.getEnvironment();
		if (!env) {
			// Extension host processes are only allowed in remote extension hosts currently
			throw new Error('Could not fetch remote environment');
		}

		this._logService.trace('Spawning remote agent process', { terminalId: this._id });

		const startResult = await this._remoteTerminalChannel.start(this._id);

		if (typeof startResult !== 'undefined') {
			// An error occurred
			return startResult;
		}

		this._startBarrier.open();
		return undefined;
	}

	public shutdown(immediate: boolean): void {
		this._startBarrier.wait().then(_ => {
			this._remoteTerminalChannel.shutdown(this._id, immediate);
		});
	}

	public input(data: string): void {
		if (this._inReplay) {
			return;
		}

		this._startBarrier.wait().then(_ => {
			this._remoteTerminalChannel.input(this._id, data);
		});
	}

	public resize(cols: number, rows: number): void {
		if (this._inReplay) {
			return;
		}
		this._startBarrier.wait().then(_ => {

			this._remoteTerminalChannel.resize(this._id, cols, rows);
		});
	}

	public acknowledgeDataEvent(charCount: number): void {
		// Support flow control for server spawned processes
		if (this._inReplay) {
			return;
		}

		this._startBarrier.wait().then(_ => {
			this._remoteTerminalChannel.acknowledgeDataEvent(this._id, charCount);
		});
	}

	public async getInitialCwd(): Promise<string> {
		await this._startBarrier.wait();
		return this._remoteTerminalChannel.getInitialCwd(this._id);
	}

	public async getCwd(): Promise<string> {
		await this._startBarrier.wait();
		return this._remoteTerminalChannel.getCwd(this._id);
	}

	handleData(e: string | IProcessDataEvent) {
		this._onProcessData.fire(e);
	}
	processBinary(e: string) {
		this._onProcessBinary.fire(e);
	}
	handleExit(e: number | undefined) {
		this._onProcessExit.fire(e);
	}
	handleReady(e: { pid: number, cwd: string }) {
		this._onProcessReady.fire(e);
	}
	handleTitleChanged(e: string) {
		this._onProcessTitleChanged.fire(e);
	}
	handleShellTypeChanged(e: TerminalShellType | undefined) {
		this._onProcessShellTypeChanged.fire(e);
	}
	handleOverrideDimensions(e: ITerminalDimensionsOverride | undefined) {
		this._onProcessOverrideDimensions.fire(e);
	}
	handleResolvedShellLaunchConfig(e: IShellLaunchConfig) {
		// Revive the cwd URI
		if (e.cwd && typeof e.cwd !== 'string') {
			e.cwd = URI.revive(e.cwd);
		}
		this._onProcessResolvedShellLaunchConfig.fire(e);
	}

	handleReplay(e: IPtyHostProcessReplayEvent) {
		try {
			this._inReplay = true;
			for (const innerEvent of e.events) {
				if (innerEvent.cols !== 0 || innerEvent.rows !== 0) {
					// never override with 0x0 as that is a marker for an unknown initial size
					this._onProcessOverrideDimensions.fire({ cols: innerEvent.cols, rows: innerEvent.rows, forceExactSize: true });
				}
				this._onProcessData.fire({ data: innerEvent.data, sync: true });
			}
		} finally {
			this._inReplay = false;
		}

		// remove size override
		this._onProcessOverrideDimensions.fire(undefined);
	}

	handleOrphanQuestion() {
		this._remoteTerminalChannel.orphanQuestionReply(this._id);
	}

	public async getLatency(): Promise<number> {
		return 0;
	}
}
