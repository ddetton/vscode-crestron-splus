import {
	ExtensionContext,
	Disposable,
	languages,
	Range,
	TextDocument,
	TextEdit,
	workspace,
	tasks,
	window,
	Task,
	commands,
	TaskDefinition,
	Uri,
	ShellExecution,
	TaskGroup,
	OutputChannel,
	FormattingOptions,
	CancellationToken,
	DocumentRangeFormattingEditProvider,
	DocumentFormattingEditProvider
} from "vscode";

import * as fs from 'fs';
import { fileURLToPath } from "url";

let taskProvider: Disposable | undefined;

export function activate(context: ExtensionContext) {

	let localhelp_command = commands.registerCommand("splus.localHelp", () => {
		callShellCommand(workspace.getConfiguration("splus").helpLocation);
	});

	let webhelp_command = commands.registerCommand("splus.webHelp", openWebHelp);

	function rebuildTaskList(): void {
		if (taskProvider) {
			taskProvider.dispose();
			taskProvider = undefined;
		}
		if (!taskProvider && window.activeTextEditor.document.languageId === "splus-source") {
			let splusPromise: Thenable<Task[]> | undefined = undefined;
			taskProvider = tasks.registerTaskProvider('splus', {
				provideTasks: () => {
					if (!splusPromise) {
						splusPromise = getCompileTasks();
					}

					return splusPromise;
				},
				resolveTask: () => {
					return undefined;
				}
			})
		}
	}

	let thisFormatProvider = new formattingProvider(formatProvider);
	languages.registerDocumentFormattingEditProvider({ scheme: 'file', language: 'splus-source' }, thisFormatProvider);

	context.subscriptions.push(localhelp_command);
	context.subscriptions.push(webhelp_command);

	workspace.onDidChangeConfiguration(rebuildTaskList);
	workspace.onDidOpenTextDocument(rebuildTaskList);
	workspace.onDidSaveTextDocument(rebuildTaskList);
	window.onDidChangeActiveTextEditor(rebuildTaskList);

	rebuildTaskList();
}

function openWebHelp(): void {
	commands.executeCommand('browser-preview.openPreview', 'http://help.crestron.com/simpl_plus');
}

export interface RangeFormattingOptions {
	rangeStart: number;
	rangeEnd: number;
}

export class formattingProvider
	implements
	DocumentRangeFormattingEditProvider,
	DocumentFormattingEditProvider {
	constructor(
		private provideEdits: (
			document: TextDocument,
			options?: RangeFormattingOptions
		) => Promise<TextEdit[]>
	) { }


	public async provideDocumentRangeFormattingEdits(
		document: TextDocument,
		range: Range,
		options: FormattingOptions,
		token: CancellationToken
	): Promise<TextEdit[]> {
		return this.provideEdits(document, {
			rangeEnd: document.offsetAt(range.end),
			rangeStart: document.offsetAt(range.start),
		});
	}

	public async provideDocumentFormattingEdits(
		document: TextDocument,
		options: FormattingOptions,
		token: CancellationToken
	): Promise<TextEdit[]> {
		return this.provideEdits(document);
	}
}

function fullDocumentRange(document: TextDocument): Range {
	const lastLineId = document.lineCount - 1;
	return new Range(0, 0, lastLineId, document.lineAt(lastLineId).text.length);
}

async function formatProvider(document: TextDocument, options?: RangeFormattingOptions): Promise<TextEdit[]> {
	let outputText = formatText(document.getText());
	return [new TextEdit(
		fullDocumentRange(document),
		outputText)];
}

function formatText(docText: string): string {
	// Set up variables for grabbing and replacing the text
	let outputText = "";
	let indentLevel = 0;                                        // Current line indent level (number of tabs)
	let inComment = 0;                                          // If we're in a comment and what level
	let inSignalList = 0;										// If we're in a list of signals
	let startingComment = 0;                                    // Check if this line starts a comment
	let endingComment = 0;                                      // Check if this line ends a comment
	let startingSignalList = 0;
	let docLines = docText.split(/\r?\n/);                      // Split into lines

	// Comment weeders
	let reDeCom1 = /(\/\/.*)/gm;                                // Single line comment
	let reDeCom2 = /((?:\(\*|\/\*).*(?:\*\)|\*\/))/gm;          // Fully enclosed multiline comment
	let reDeCom3 = /(.*(?:\*\)|\*\/))/gm;                       // Closing multiline comment
	let reDeCom4 = /((?:\(\*|\/\*).*)/gm;                       // Opening multiline comment
	let reString = /'[^']*'/gm;

	for (var line = 0; line < docLines.length; line++) {
		startingComment = 0;
		endingComment = 0;
		let thisLine = docLines[line];
		let thisLineTrimmed = docLines[line].trimLeft();
		let thisLineClean = docLines[line].trimLeft().replace(reDeCom1, "").replace(reDeCom2, "");      // Remove any single line comments and fully enclosed multiline comments

		if (reDeCom3.test(thisLineClean) && inComment > 0) {        // If a multiline comment closes on this line, decrease our comment level
			inComment = inComment - 1;
			if (inComment === 0) {
				endingComment = 1;
			}
		}
		if (reDeCom4.test(thisLineClean)) {                         // If a multiline comment opens on this line, increase our comment level
			if (inComment === 0) {
				startingComment = 1;                                    // If this line starts a multiline comment, it still needs to be checked
			}
			inComment = inComment + 1;
		}

		thisLineClean = thisLineClean.replace(reDeCom3, "").replace(reDeCom4, "");            // Remove any code that we think is inside multiline comments
		thisLineClean = thisLineClean.replace(reString, "");                                  // Remove any string literals from the line so we don't get false positives
		let brOpen = countChars(thisLineClean, '{') - countChars(thisLineClean, '}');         // Check the delta for squiggly brackets
		let sqOpen = countChars(thisLineClean, '[') - countChars(thisLineClean, ']');         // Check the delta for square brackets
		let parOpen = countChars(thisLineClean, '(') - countChars(thisLineClean, ')');        // Check the delta for parenthesis
		let indentDelta = brOpen + sqOpen + parOpen;                                          // Calculate total delta

		if ((
			thisLineClean.toLowerCase().includes("digital_input") ||
			thisLineClean.toLowerCase().includes("analog_input") ||
			thisLineClean.toLowerCase().includes("string_input") ||
			thisLineClean.toLowerCase().includes("buffer_input") ||
			thisLineClean.toLowerCase().includes("digital_output") ||
			thisLineClean.toLowerCase().includes("analog_output") ||
			thisLineClean.toLowerCase().includes("string_output")
		) && !thisLineClean.includes(";")) {
			inSignalList = 1;
			startingSignalList = 1;
		}

		// Indent Increase Rules
		if (inSignalList == 1) {
			if (startingSignalList == 1) {
				outputText = outputText + thisLineTrimmed + "\r";
				startingSignalList = 0;
			}
			else {
				outputText = outputText + ('\t'.repeat(4)) + thisLineTrimmed + "\r";
				if (thisLineTrimmed.includes(";")) {
					inSignalList = 0;
				}
			}
		}
		else if ((inComment > 0 && !startingComment) || (!inComment && endingComment)) {           // If we're in a multiline comment, just leave the line alone unless it's the start of a ML comment
			outputText = outputText + thisLine + "\r";
		}
		else if (indentDelta > 0) {                                                         // If we're increasing indent delta because of this line, the add it, then increase indent
			outputText = outputText + ('\t'.repeat(indentLevel)) + thisLineTrimmed + "\r";
			indentLevel = (indentLevel + indentDelta >= 0) ? (indentLevel + indentDelta) : 0;
		}
		// If we're decreasing delta, and the line starts with the character that is decreasing it, then decrease first, and then add this line
		else if (indentDelta < 0 && (thisLineClean[0] === '}' || thisLineClean[0] === ']' || thisLineClean[0] === ')')) {
			indentLevel = (indentLevel + indentDelta >= 0) ? (indentLevel + indentDelta) : 0;
			outputText = outputText + ('\t'.repeat(indentLevel)) + thisLineTrimmed + "\r";
		}
		else if (indentDelta < 0) {                                                         // If we're decreasing delta but the first character isn't the cause, then we're still inside the block
			outputText = outputText + ('\t'.repeat(indentLevel)) + thisLineTrimmed + "\r";
			indentLevel = (indentLevel + indentDelta >= 0) ? (indentLevel + indentDelta) : 0;
		}
		else {                                                                              // indentDelta === 0; do nothing except add the line with the indent
			outputText = outputText + ('\t'.repeat(indentLevel)) + thisLineTrimmed + "\r";
		}
	};

	return outputText;
}

// Creates a terminal, calls the command, then closes the terminal
function callShellCommand(shellCommand: string): void {
	let term = window.createTerminal('splus', 'c:\\windows\\system32\\cmd.exe');
	term.sendText("\"" + shellCommand + "\"", true);
	term.sendText("exit", true);
}

function countChars(haystack: string, needle: string): number {
	let count = 0;
	for (var i = 0; i < haystack.length; i++) {
		if (haystack[i] === needle) {
			count++;
		}
	}
	return count;
}

interface SplusTaskDefinition extends TaskDefinition {
	label: string;
	buildPath: string;
}

class SplusCompiler {
	constructor() {
		this.filepaths = [];
		this.compilerPath = "\"" + workspace.getConfiguration("splus").compilerLocation + "\"";
	}
	buildCommand() {
		let filepathConcat = "";
		this.filepaths.forEach(element => {
			filepathConcat += element + " ";
		});
		return this.compilerPath +
			" " +
			filepathConcat;
	}

	filepaths: string[];
	compilerPath: string;
}

function getCompileCommand(fileName: string, buildType: number): string {
	let compiler = new SplusCompiler();
	compiler.filepaths.push("\\rebuild \"" + fileName + "\"");
	if (buildType === 1) {
		compiler.filepaths.push("\\target series3");
	}
	else if (buildType === 2) {
		compiler.filepaths.push("\\target series3 series2");
	}
	else if (buildType === 3) {
		compiler.filepaths.push("\\target series2");
	}
	else if (buildType === 4) {
		compiler.filepaths.push("\\target series4");
	}
	else if (buildType === 5) {
		compiler.filepaths.push("\\target series3 series4");
	}
	else if (buildType === 6) {
		compiler.filepaths.push("\\target series2 series3 series4");
	}

	return compiler.buildCommand();
}

function getApiCommand(apiFileName: string, thisFileDir: string): string {
	let workDir = thisFileDir + "SPlsWork\\";
	return "\"" + workDir + "splusheader.exe\" \"" + workDir + apiFileName + ".dll\" \"" + thisFileDir + apiFileName + ".api\"";
}

function getApiInIncludeCommand(apiFileName: string, thisFileDir: string, includePaths: string[]): string {
	includePaths.forEach((path: string) => {
		let thisPath = path.slice(14,-1);
		let workDir = thisFileDir;
		if (workDir.endsWith("\\")) {
			workDir = workDir.slice(0, -1);
		}
		while (thisPath.startsWith("..\\\\")) {
			thisPath = thisPath.slice(3);
			workDir = workDir.slice(0, workDir.lastIndexOf("\\"));
		}
		if (!thisPath.endsWith("\\")) {
			thisPath = thisPath + "\\";
		}
		if (fs.existsSync(workDir + "\\" + thisPath + apiFileName + ".dll")) {
			return "\"" + workDir + "splusheader.exe\" \"" + workDir + apiFileName + ".dll\" \"" + thisFileDir + apiFileName + ".api\"";
		}
	})

	return "";
}

async function getCompileTasks(): Promise<Task[]> {
	let workspaceRoot = workspace.rootPath;
	let emptyTasks: Task[] = [];

	if (!workspaceRoot) {
		return emptyTasks;
	}

	try {
		let result: Task[] = [];
		let editor = window.activeTextEditor;
		let doc = editor.document;
		let executable = 'c:\\windows\\system32\\cmd.exe';

		let sSharpLibRegEx = /(#USER_SIMPLSHARP_LIBRARY|#CRESTRON_SIMPLSHARP_LIBRARY)\s*\"([\w\.\-]*)\"/gmi;
		let sSharpIncludeRegEx = /#INCLUDEPATH\s*\"([\w\.\-]*)\"/gmi;

		let sSharpLibs = doc.getText().match(sSharpLibRegEx);
		let sSharIncludes = doc.getText().match(sSharpIncludeRegEx);

		if (sSharpLibs != null && sSharpLibs.length > 0) {
			sSharpLibs.forEach((regexMatch: string) => {
				let fileName = "";
				if(regexMatch.toLowerCase().startsWith("#user_simplsharp_library")) {
					fileName = regexMatch.slice(26, -1);
				}
				else if (regexMatch.toLowerCase().startsWith("#crestron_simplsharp_library")) {
					fileName = regexMatch.slice(30, -1);
				}
				let thisFileDir = doc.fileName.slice(0, doc.fileName.lastIndexOf("\\") + 1);

				if (fs.existsSync(thisFileDir + "SPlsWork\\" + fileName + ".dll")) {
					let buildCommand = getApiCommand(fileName, thisFileDir);

					let taskDef: SplusTaskDefinition = {
						type: 'shell',
						label: 'Build API for ' + fileName,
						buildPath: buildCommand
					}

					let command: ShellExecution = new ShellExecution(`"${buildCommand}"`, { executable: executable, shellArgs: ['/c'] });
					let task = new Task(taskDef, taskDef.label, 'crestron-splus', command, '');
					task.definition = taskDef;
					task.group = TaskGroup.Build;

					result.push(task);
				}
			})
		}

		if (workspace.getConfiguration("splus").enable3series == true) {
			// Create 3 series compile build task
			let buildCommand = getCompileCommand(doc.fileName, 1);

			let taskDef: SplusTaskDefinition = {
				type: 'shell',
				label: 'S+ Compile 3 Series',
				buildPath: buildCommand
			}

			let command: ShellExecution = new ShellExecution(`"${buildCommand}"`, { executable: executable, shellArgs: ['/c'] });
			let task = new Task(taskDef, taskDef.label, 'crestron-splus', command, `$splusCC`);
			task.definition = taskDef;
			task.group = TaskGroup.Build;

			result.push(task);
		}

		if (workspace.getConfiguration("splus").enable2series == true && workspace.getConfiguration("splus").enable3series == true) {
			// Create 2 and 3 series build task
			let buildCommand = getCompileCommand(doc.fileName, 2);

			let taskDef: SplusTaskDefinition = {
				type: 'shell',
				label: 'S+ Compile 2 and 3 Series',
				buildPath: buildCommand
			}

			let command = new ShellExecution(`"${buildCommand}"`, { executable: executable, shellArgs: ['/c'] });
			let task = new Task(taskDef, taskDef.label, 'crestron-splus', command, `$splusCC`);
			task.definition = taskDef;
			task.group = TaskGroup.Build;

			result.push(task);
		}

		if (workspace.getConfiguration("splus").enable2series == true) {
			// Create 2 series build task
			let buildCommand = getCompileCommand(doc.fileName, 3);

			let taskDef: SplusTaskDefinition = {
				type: 'shell',
				label: 'S+ Compile 2 Series',
				buildPath: buildCommand
			}

			let command = new ShellExecution(`"${buildCommand}"`, { executable: executable, shellArgs: ['/c'] });
			let task = new Task(taskDef, taskDef.label, 'crestron-splus', command, `$splusCC`);
			task.definition = taskDef;
			task.group = TaskGroup.Build;

			result.push(task);
		}

		if (workspace.getConfiguration("splus").enable4series == true) {
			// Create 2 series build task
			let buildCommand = getCompileCommand(doc.fileName, 4);

			let taskDef: SplusTaskDefinition = {
				type: 'shell',
				label: 'S+ Compile 4 Series',
				buildPath: buildCommand
			}

			let command = new ShellExecution(`"${buildCommand}"`, { executable: executable, shellArgs: ['/c'] });
			let task = new Task(taskDef, taskDef.label, 'crestron-splus', command, `$splusCC`);
			task.definition = taskDef;
			task.group = TaskGroup.Build;

			result.push(task);
		}

		if (workspace.getConfiguration("splus").enable4series == true && workspace.getConfiguration("splus").enable3series == true) {
			// Create 2 series build task
			let buildCommand = getCompileCommand(doc.fileName, 5);

			let taskDef: SplusTaskDefinition = {
				type: 'shell',
				label: 'S+ Compile 3 and 4 Series',
				buildPath: buildCommand
			}

			let command = new ShellExecution(`"${buildCommand}"`, { executable: executable, shellArgs: ['/c'] });
			let task = new Task(taskDef, taskDef.label, 'crestron-splus', command, `$splusCC`);
			task.definition = taskDef;
			task.group = TaskGroup.Build;

			result.push(task);
		}

		if (workspace.getConfiguration("splus").enable4series == true && workspace.getConfiguration("splus").enable3series == true && workspace.getConfiguration("splus").enable2series == true) {
			// Create 2 series build task
			let buildCommand = getCompileCommand(doc.fileName, 6);

			let taskDef: SplusTaskDefinition = {
				type: 'shell',
				label: 'S+ Compile 2, 3 and 4 Series',
				buildPath: buildCommand
			}

			let command = new ShellExecution(`"${buildCommand}"`, { executable: executable, shellArgs: ['/c'] });
			let task = new Task(taskDef, taskDef.label, 'crestron-splus', command, `$splusCC`);
			task.definition = taskDef;
			task.group = TaskGroup.Build;

			result.push(task);
		}


		return result;
	}
	catch (err) {
		let channel = getOutputChannel();
		console.log(err);
		if (err.stderr) {
			channel.appendLine(err.stderr);
		}
		if (err.stdout) {
			channel.appendLine(err.stdout);
		}

		channel.appendLine('S+ compile failed');
		channel.show(true);
		return emptyTasks;
	}
}

let _channel: OutputChannel;
function getOutputChannel(): OutputChannel {
	if (!_channel) {
		_channel = window.createOutputChannel("S+ Compile");
	}
	return _channel;
}

// this method is called when your extension is deactivated
export function deactivate(): void {
	if (taskProvider) {
		taskProvider.dispose();
	}
}
