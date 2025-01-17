/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as Path from 'path';
import * as FS from 'fs';
import * as CP from 'child_process';
import * as nls from 'vscode-nls';

const localize = nls.loadMessageBundle();

export class Terminal
{
	private static _terminalService: ITerminalService;

	public static launchInTerminal(dir: string, args: string[], envVars: { [key: string]: string; }): Promise<CP.ChildProcess> {
		return this.terminalService().launchInTerminal(dir, args, envVars);
	}

	public static killTree(processId: number): Promise<any> {
		return this.terminalService().killTree(processId);
	}

	/*
	 * Is the given runtime executable on the PATH.
	 */
	public static isOnPath(program: string): boolean {
		return this.terminalService().isOnPath(program);
	}

	private static terminalService(): ITerminalService {
		if (!this._terminalService) {
			if (process.platform === 'win32') {
				this._terminalService = new WindowsTerminalService();
			} else if (process.platform === 'darwin') {
				this._terminalService = new MacTerminalService();
			} else if (process.platform === 'linux') {
				this._terminalService = new LinuxTerminalService();
			} else {
				this._terminalService = new DefaultTerminalService();
			}
		}
		return this._terminalService;
	}
}


export class TerminalError {

	public message: string;
	public linkId: number;

	constructor(message: string, linkId?: number) {
		this.message = message;
		this.linkId = linkId;
	}
}

interface ITerminalService {
	launchInTerminal(dir: string, args: string[], envVars: { [key: string]: string; }): Promise<CP.ChildProcess>;
	killTree(pid: number) : Promise<any>;
	isOnPath(program: string): boolean;
}

class DefaultTerminalService implements ITerminalService {

	protected static TERMINAL_TITLE = localize('console.title', "VS Code Console");
	private static WHICH = '/usr/bin/which';

	public launchInTerminal(dir: string, args: string[], envVars: { [key: string]: string; }): Promise<CP.ChildProcess> {
		return new Promise<CP.ChildProcess>( (resolve, reject) => {
			reject(new TerminalError(localize('external.console.not.implemented', "External console not implemented on '{0}'.", process.platform)));
		});
	}

	public killTree(pid: number): Promise<any> {

		// on linux and OS X we kill all direct and indirect child processes as well

		return new Promise<any>( (resolve, reject) => {
			try {
				const cmd = Path.join(__dirname, './terminateProcess.sh');
				const result = (<any>CP).spawnSync(cmd, [ pid.toString() ]);
				if (result.error) {
					reject(result.error);
				} else {
					resolve();
				}
			} catch (err) {
				reject(err);
			}
		});
	}

	public isOnPath(program: string): boolean {

		try {
			if (!FS.existsSync(DefaultTerminalService.WHICH)) {
				CP.execSync(`${DefaultTerminalService.WHICH} '${program}'`);
			}
			return true;
		}
		catch (Exception) {
		}
		return false;
	}
}

class WindowsTerminalService extends DefaultTerminalService {

	private static CMD = 'cmd.exe';
	private static WHERE = 'where';

	public launchInTerminal(dir: string, args: string[], envVars: { [key: string]: string; }): Promise<CP.ChildProcess> {

		return new Promise<CP.ChildProcess>( (resolve, reject) => {

			const title = `"${dir} - ${WindowsTerminalService.TERMINAL_TITLE}"`;
			const command = `""${args.join('" "')}" & pause"`; // use '|' to only pause on non-zero exit code

			const cmdArgs = [
				'/c', 'start', title, '/wait',
				'cmd.exe', '/c', command
			];

			// merge environment variables into a copy of the process.env
			const env = extendObject(extendObject( { }, process.env), envVars);

			const options: any = {
				cwd: dir,
				env: env,
				windowsVerbatimArguments: true
			};

			const cmd = CP.spawn(WindowsTerminalService.CMD, cmdArgs, options);
			cmd.on('error', reject);

			resolve(cmd);
		});
	}

	public killTree(pid: number): Promise<any> {

		// when killing a process in Windows its child processes are *not* killed but become root processes.
		// Therefore we use TASKKILL.EXE

		return new Promise<any>( (resolve, reject) => {
			const cmd = `taskkill /F /T /PID ${pid}`;
			try {
				CP.execSync(cmd);
				resolve();
			}
			catch (err) {
				reject(err);
			}
		});
	}

	public isOnPath(program: string): boolean {

		try {
			CP.execSync(`${WindowsTerminalService.WHERE} ${program}`);
			return true;
		}
		catch (Exception) {
			// ignore
		}
		return false;
	}
}

class LinuxTerminalService extends DefaultTerminalService {

	private static LINUX_TERM = '/usr/bin/gnome-terminal';	//private const string LINUX_TERM = "/usr/bin/x-terminal-emulator";
	private static WAIT_MESSAGE = localize('press.any.key', "Press any key to continue...");

	public launchInTerminal(dir: string, args: string[], envVars: { [key: string]: string; }): Promise<CP.ChildProcess> {

		return new Promise<CP.ChildProcess>( (resolve, reject) => {

			if (!FS.existsSync(LinuxTerminalService.LINUX_TERM)) {
				reject(new TerminalError(localize('program.not.found', "'{0}' not found", LinuxTerminalService.LINUX_TERM), 20002));
				return;
			}

			const bashCommand = `${quote(args)}; echo; read -p "${LinuxTerminalService.WAIT_MESSAGE}" -n1;`;

			const termArgs = [
				'--title', `"${LinuxTerminalService.TERMINAL_TITLE}"`,
				'-x', 'bash', '-c',
				`''${bashCommand}''` 	// wrapping argument in two sets of ' because node is so "friendly" that it removes one set...
			];

			// merge environment variables into a copy of the process.env
			const env = extendObject(extendObject( { }, process.env), envVars);

			const options: any = {
				cwd: dir,
				env: env
			};

			const cmd = CP.spawn(LinuxTerminalService.LINUX_TERM, termArgs, options);
			cmd.on('error', reject);
			cmd.on('exit', (code: number) => {
				if (code === 0) {	// OK
					resolve();	// since cmd is not the terminal process but just a launcher, we do not pass it in the resolve to the caller
				} else {
					reject(new TerminalError(localize('program.failed', "{0} failed with exit code {1}", LinuxTerminalService.LINUX_TERM, code)));
				}
			});
		});
	}
}

class MacTerminalService extends DefaultTerminalService {

	private static OSASCRIPT = '/usr/bin/osascript';	// osascript is the AppleScript interpreter on OS X

	public launchInTerminal(dir: string, args: string[], envVars: { [key: string]: string; }): Promise<CP.ChildProcess> {

		return new Promise<CP.ChildProcess>( (resolve, reject) => {

			// first fix the PATH so that 'runtimePath' can be found if installed with 'brew'
			// Utilities.FixPathOnOSX();

			// On OS X we do not launch the program directly but we launch an AppleScript that creates (or reuses) a Terminal window
			// and then launches the program inside that window.

			const osaArgs = [
				Path.join(__dirname, './terminalHelper.scpt'),
				'-t', MacTerminalService.TERMINAL_TITLE,
				'-w', dir,
			];

			for (let a of args) {
				osaArgs.push('-pa');
				osaArgs.push(a);
			}

			if (envVars) {
				for (let key in envVars) {
					osaArgs.push('-e');
					osaArgs.push(key + '=' + envVars[key]);
				}
			}

			let stderr = '';
			const osa = CP.spawn(MacTerminalService.OSASCRIPT, osaArgs);
			osa.on('error', reject);
			osa.stderr.on('data', (data) => {
				stderr += data.toString();
			});
			osa.on('exit', (code: number) => {
				if (code === 0) {	// OK
					resolve();	// since cmd is not the terminal process but just the osa tool, we do not pass it in the resolve to the caller
				} else {
					if (stderr) {
						reject(new TerminalError(stderr));
					} else {
						reject(new TerminalError(localize('program.failed', "{0} failed with exit code {1}", MacTerminalService.OSASCRIPT, code)));
					}
				}
			});
		});
	}
}

// ---- private utilities ----

/**
 * Quote args if necessary and combine into a space separated string.
 */
function quote(args: string[]): string {
	let r = '';
	for (let a of args) {
		if (a.indexOf(' ') >= 0) {
			r += '"' + a + '"';
		} else {
			r += a;
		}
		r += ' ';
	}
	return r;
}

function extendObject<T> (objectCopy: T, object: T): T {

	for (let key in object) {
		if (object.hasOwnProperty(key)) {
			objectCopy[key] = object[key];
		}
	}

	return objectCopy;
}
