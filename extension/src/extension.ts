import { startWebSocketServer } from "@hediet/typed-json-rpc-websocket-server";
import {
	Disposable,
	window,
	OutputChannel,
	ExtensionContext,
	StatusBarAlignment,
	commands,
	workspace,
	ViewColumn,
} from "vscode";
import { WebSocketStream } from "@hediet/typed-json-rpc-websocket";
import { EditorServer } from "./editorServer";
import { NodeDebugServer } from "./nodeDebugger";
import {
	authenticationContract,
	vscodeClientContract,
	RegistrarPort,
} from "vscode-rpc";
import { readFileSync } from "fs";
import { StatusBarOptionService } from "./StatusBarOptionService";
import getPort from "get-port";
import { Barrier } from "@hediet/std/synchronization";
import {
	RpcLogger,
	TypedChannel,
	MessageStream,
	RpcStreamLogger,
} from "@hediet/typed-json-rpc";
import { DisposableComponent } from "@hediet/std/disposable";
import { startRegistrarProcessIfNotRunning } from "./registrar";

class Extension extends DisposableComponent {
	private readonly outputChannel: OutputChannel;
	private readonly rpcLogger: RpcLogger;
	private readonly editorServer: EditorServer;
	private nodeDebugServer!: NodeDebugServer;
	private registrar!: typeof vscodeClientContract.TServerInterface;

	constructor() {
		super();
		this.outputChannel = window.createOutputChannel("RPC Server Log");
		this.addDisposable(this.outputChannel);

		this.rpcLogger = {
			debug: args => this.outputChannel.appendLine(args.text),
			trace: args => this.outputChannel.appendLine(args.text),
			warn: args => this.outputChannel.appendLine(args.text),
		};

		this.editorServer = new EditorServer();

		this.startServer().catch(reason => {
			console.error(reason);
			if (reason && "message" in reason) {
				reason = reason.message;
			}
			this.outputChannel.appendLine(
				`Error while starting server: ${reason}`
			);
		});

		this.addDisposable(this.authStatusBar);
		this.addDisposable({
			dispose: () => {
				for (const opt of this.allowAccessStatusBarItems.values()) {
					opt.dispose();
				}
				this.allowAccessStatusBarItems.clear();
			},
		});

		this.addDisposable(
			commands.registerCommand(
				"vscode-rpc-server.open-server-config",
				async () => {
					const { path } = await this.registrar.getConfigFileName({});
					const d = await workspace.openTextDocument(path);
					window.showTextDocument(d, ViewColumn.Active);
				}
			)
		);

		this.addDisposable(
			commands.registerCommand(
				"vscode-rpc-server.reload-server-config",
				async () => {
					await this.registrar.reloadConfig({});
				}
			)
		);
	}

	private async startServer() {
		await startRegistrarProcessIfNotRunning();

		const registrarClient = await WebSocketStream.connectTo({
			host: "localhost",
			port: RegistrarPort,
		});
		this.addDisposable(registrarClient);
		const registrarStream = new RpcStreamLogger(
			registrarClient,
			this.rpcLogger
		);
		const registrarChannel = TypedChannel.fromStream(
			registrarStream,
			this.rpcLogger
		);
		this.registrar = vscodeClientContract.getServer(registrarChannel, {
			authenticateVsCodeInstance: async ({ filePathToRead }) => {
				const content = readFileSync(filePathToRead, {
					encoding: "utf8",
				});
				return { content };
			},
			requestAccess: this.requestAccess,
			cancelAccessRequest: this.cancelAccessRequest,
			clientDisconnected: async ({ clientId }) =>
				this.nodeDebugServer.onClientDisconnected(clientId),
		});

		this.nodeDebugServer = new NodeDebugServer(
			this.outputChannel,
			registrarChannel
		);
		this.nodeDebugServer.handleClient(registrarChannel, registrarStream);

		registrarChannel.startListen();
		const port = await getPort();
		const server = startWebSocketServer({ port }, stream => {
			const channel = TypedChannel.fromStream(
				new RpcStreamLogger(stream, this.rpcLogger),
				this.rpcLogger
			);
			this.handleClient(channel, stream);
		});

		await this.registrar.registerAsVsCodeInstance({
			name: "VSCode",
			vscodeServerPort: server.port,
		});

		this.addDisposable(server);

		window.showInformationMessage("RPC Server ready");
	}

	private readonly clients = new Set<VscodeClient>();

	private handleClient(channel: TypedChannel, stream: MessageStream) {
		const client = { stream };

		authenticationContract.registerServer(channel, {
			authenticate: async ({ appName, token }) => {
				await this.registrar.authenticateClient({
					appName,
					token,
				});

				this.clients.add(client);

				this.editorServer.handleClient(channel, stream);
				this.nodeDebugServer.handleClient(channel, stream);

				stream.onClosed.then(() => {
					this.clients.delete(client);
				});
			},
			requestToken: async ({ appName }) => {
				throw new Error("Not supported");
			},
		});

		channel.startListen();
	}

	private allowAccessStatusBarItems = new Map<number, Disposable>();

	private readonly cancelAccessRequest: typeof vscodeClientContract.TClientInterface.cancelAccessRequest = async ({
		requestId,
	}) => {
		const d = this.allowAccessStatusBarItems.get(requestId);
		if (d) {
			d.dispose();
			this.allowAccessStatusBarItems.delete(requestId);
		}
	};

	private readonly authStatusBar = new StatusBarOptionService({
		id: "authStatusBar",
		alignment: StatusBarAlignment.Right,
		priority: 1000000,
	});

	private readonly requestAccess: typeof vscodeClientContract.TClientInterface.requestAccess = async ({
		appName,
		requestId,
	}) => {
		let b = new Barrier<{ accessGranted: boolean }>();

		let x = 10;
		x = x;
		this.allowAccessStatusBarItems.set(
			requestId,
			this.authStatusBar.addOptions({
				options: [
					{
						caption: `$(key) Grant RPC Token to "${appName}"`,
						action: () => {
							this.allowAccessStatusBarItems.delete(requestId);
							b.unlock({
								accessGranted: true,
							});
						},
					},
					{
						caption: "Deny",
						action: () => {
							this.allowAccessStatusBarItems.delete(requestId);
							b.unlock({
								accessGranted: false,
							});
						},
					},
				],
			})
		);

		return await b.onUnlocked;
	};
}

interface VscodeClient {
	stream: MessageStream;
}

export function activate(context: ExtensionContext) {
	const ext = new Extension();
	context.subscriptions.push(ext);
}

export function deactivate() {}
