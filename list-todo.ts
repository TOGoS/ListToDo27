/// <reference lib="deno.ns"/>

import * as tef from "https://deno.land/x/tef@0.3.3/tef.ts";
import { readerToIterable } from "https://deno.land/x/tef@0.3.4/util/denostreamutil.ts";

interface TEFHeader {
	key : string;
	value : string;
}

interface TEFEntry {
	typeString : string;
	idString : string;
	headers : TEFHeader[];
	contentChunks : Uint8Array[];
}

function makeBlankTefEntry() : TEFEntry {
	return {
		typeString: "",
		idString: "",
		headers: [],
		contentChunks: [],
	};
}

function tefEntryIsEmpty( entry : TEFEntry ) : boolean {
	if( entry.typeString.length > 0 ) return false;
	if( entry.idString.length > 0 ) return false;
	if( entry.headers.length > 0 ) return false;
	if( entry.contentChunks.length > 0 ) return false;
	return true;
}

async function *tefPiecesToEntries( pieces : AsyncIterable<tef.TEFPiece> ) : AsyncGenerator<TEFEntry> {
	let currentEntry : TEFEntry = makeBlankTefEntry();

	for await( const piece of pieces ) {
		if( piece.type == "new-entry" ) {
			if( !tefEntryIsEmpty(currentEntry) ) {
				yield(currentEntry);
				currentEntry = makeBlankTefEntry();
			}
			currentEntry.typeString = piece.typeString;
			currentEntry.idString = piece.idString;
		} else if( piece.type == "comment" ) {
			// Skip
		} else if( piece.type == "content-chunk" ) {
			currentEntry.contentChunks.push(piece.data);
		} else if( piece.type == "header" ) {
			currentEntry.headers.push(piece);
		}
	}
}

//// Phrase translator

interface Phrase {
	english : string;
	camelCase : string;
	dashSeparated : string;
}

class PhraseTranslator {
	phrases : Map<string,Phrase> = new Map();
	addEnglish(english : string) {
		if( this.phrases.has(english) ) return;

		const words = english.split(' ');

		const lcWords = words.map(w => (w == 'e-mail' ? 'email' : w).toLowerCase());

		const ccWords = [lcWords[0]];
		for( let i=1; i<lcWords.length; ++i ) {
			ccWords[i] = lcWords[i].charAt(0).toUpperCase() + lcWords[i].substring(1);
		}
		const camelCase = ccWords.join('');
		const dashSeparated = lcWords.join('-');
		const phrase : Phrase = { english, camelCase, dashSeparated };
		this.phrases.set(english, phrase);
		this.phrases.set(camelCase, phrase);
		this.phrases.set(dashSeparated, phrase);
	}
	addDashed(dashed : string) {
		this.addEnglish(dashed.split('-').join(' '));
	}
	get(phraseStr : string) : Phrase {
		const phrase = this.phrases.get(phraseStr);
		if( phrase == undefined ) throw new Error(`"${phraseStr}" to not in phrase database`);
		return phrase;
	}
	toDashSeparated(phraseStr : string) : string {
		return this.get(phraseStr).dashSeparated;
	}
	toCamelCase(phraseStr : string) : string {
		return this.get(phraseStr).camelCase;
	}
}

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.154.0/testing/asserts.ts";

Deno.test("phrase translator does what is expected of it", () => {
	const pt = new PhraseTranslator();
	pt.addDashed("foo-bar-baz");
	assertEquals("fooBarBaz", pt.toCamelCase("foo bar baz"));
	assertEquals("fooBarBaz", pt.toCamelCase("foo-bar-baz"));
	assertEquals("fooBarBaz", pt.toCamelCase("fooBarBaz"));
});

const phraseTranslator = new PhraseTranslator();
phraseTranslator.addEnglish('description');

// TODO: Librarify all that boilerplate!

type ItemID = string;
type TypeString = string;
type ItemIDListString = string; // Item IDs separated by whitespace and/or commas

interface Item {
	idString?: ItemID;
	typeString?: TypeString;
	title?: string;
	subtaskOf?: ItemIDListString;
	dependsOn?: ItemIDListString;
	description?: string;
	status?: string;
}
interface ItemEtc extends Item {
	[k: string]: string|undefined;
}

function strToList( str:string|undefined ) : string[] {
	if( str == undefined ) return [];
	str = str.trim();
	if( str.length == 0 ) return [];
	return str.split(/[,\s]+/);
}

function tefEntryToItem(e : Readonly<TEFEntry> ) : ItemEtc {
	// Might want to drive translation based on some schema.
	// Not yet sure exactly what that would look like.
	const trimIds = true;

	const obj : ItemEtc = {};

	// Parse ID string
	let effectiveIdString : string;
	let effectiveTitleString : string;
	let m;
	if( trimIds && (m = /^\s*(\S+)\s+(?:-\s+|#\s+)?(.*)/.exec(e.idString)) ) {
		effectiveIdString = m[1];
		effectiveTitleString = m[2];
	} else {
		effectiveIdString = e.idString;
		effectiveTitleString = "";
	}

	// Parse type string and headers
	if( effectiveIdString != "" ) obj.idString = effectiveIdString;
	if( effectiveTitleString != "" ) obj.title = effectiveTitleString;
	if( e.typeString != "" ) obj.typeString = e.typeString;
	for( const header of e.headers ) {
		phraseTranslator.addDashed(header.key);
		const ccKey = phraseTranslator.toCamelCase(header.key);

		if( header.value == "" ) continue;
		let value = obj[ccKey] ?? "";
		if( value.length > 0 ) value += "\n";
		obj[ccKey] = value + header.value.trim();
	}

	// Stringify content
	let contentLength = 0;
	for( const chunk of e.contentChunks ) {
		contentLength += chunk.length;
	}
	if( contentLength == 0 ) {
		// Don't add to object
	} else if( e.contentChunks.length == 1 ) {
		obj["description"] = new TextDecoder().decode(e.contentChunks[0]);
	} else {
		const megabuf = new Uint8Array(contentLength);
		let len = 0;
		for( const chunk of e.contentChunks ) {
			megabuf.set(chunk, len);
			len += chunk.length;
		}
	
		obj["description"] = new TextDecoder().decode(megabuf);
	}
	return obj;
}

Deno.test('tefEntryToItem', () => {
	// I'm not actually sure if the TEF library will, or even should, trim headers.
	// Actually, I suppose for the sake of preserving data, it should not.
	// Better make sure that tefEntryToItem does the job.
	const tefEntry : TEFEntry = {
		contentChunks: [
			"foo\n",
			"bar\n",
		].map(s => new TextEncoder().encode(s)),
		headers: [
			{ key: "status", value: " a choo! " }
		],
		typeString: "thingo  ",
		idString: " blingo - and here is some extra text",
	};
	const item = tefEntryToItem(tefEntry);
	assertEquals("a choo!", item.status);
	assertEquals("blingo", item.idString);
	assertEquals("and here is some extra text", item.title);
	assertEquals("foo\nbar\n", item.description);
});

import * as colors from 'https://deno.land/std@0.154.0/fmt/colors.ts';

const separatorLine = colors.gray("#".repeat(74));

type ItemPrinter = (item:Item) => Promise<void>;

function collectItemAndParentIds(items:Map<string,Item>, itemId:string, into:string[]) {
	const item = items.get(itemId);
	if( item == undefined ) {
		throw new Error(`Referenced item ${itemId} not found in items map!`);
	}
	for( const parentId of strToList(item.subtaskOf) ) {
		collectItemAndParentIds(items, parentId, into);
	}
	into.push(itemId);
}

// TODO: 'todo' should really be 'shovel ready' -- it's not limited to 'todo' tasks.
type TaskStatusConstraintName = "all"|"random-shovel-ready-task"|"shovel-ready";
type OutputFormatName = "pretty"|"json";

interface ProcessToDoList {
	actionName : "process";
	selectionMode : TaskStatusConstraintName;
	outputFormat : OutputFormatName;
}
interface ShowHelp {
	actionName : "show-help";
}
interface ShowMoreHelp {
	actionName : "show-more-help";
}
interface ComplainAboutBadArguments {
	actionName : "complain-about-arguments";
	errorMessages : string[];
}
type LTD27Action = ProcessToDoList|ShowHelp|ShowMoreHelp|ComplainAboutBadArguments;

function prettyPrintItem(item:Item) : Promise<void> {
	console.log("=" +
		colors.rgb24(item.typeString ?? "item", 0xCCAAAA) + " " +
		colors.rgb24(item.idString ?? "", 0xAACCAA) +
		(item.title ? " - " + colors.brightWhite(item.title) : '')
	);
	for( const k in item ) {
		if( k == 'typeString' || k == 'idString' || k == 'title' || k == 'description' ) continue;
		console.log(`${phraseTranslator.toDashSeparated(k)}: ${(item as ItemEtc)[k]?.replaceAll("\n", ", ")}`);
	}
	if( item.description != undefined ) {
		console.log();
		console.log(item.description.trim());
	}
	return Promise.resolve();
}

function parseStatus(status:string) : string|undefined {
	const m = /^([\w-_]+)/.exec(status);
	return (m ? m[1] : undefined);
}

Deno.test('parseStatus("done")', () => {
	assertEquals('done', parseStatus('done'));
});

Deno.test('parseStatus("done" + whitespace)', () => {
	assertEquals('done', parseStatus('done  \t ')); // just whitespace!
});

Deno.test('parseStatus("done" + comment)', () => {
	assertEquals('done', parseStatus('done ; blah, a comment'));
	assertEquals('done', parseStatus('done (2023-09-23 -- another comment)'));
	assertEquals('done', parseStatus('done ; whitespace-prefixed??'));
});

Deno.test('parseStatus(empty string)', () => {
	assertEquals(undefined, parseStatus(''));
});
Deno.test('parseStatus(empty string + comment)', () => {
	assertEquals(undefined, parseStatus('; foo'));
	assertEquals(undefined, parseStatus('(bar)'));
});

Deno.test('parseStatus("in-progress")', () => {
	assertEquals('in-progress', parseStatus('in-progress'));
});
Deno.test('parseStatus("in-progress" + stuff)', () => {
	assertEquals('in-progress', parseStatus('in-progress ; foo'));
	assertEquals('in-progress', parseStatus('in-progress (bar)'));
	assertEquals('in-progress', parseStatus('in-progress whatever'));
});


function _itemStatus(item:Item) : string|undefined {
	return item.status == undefined ? undefined : parseStatus(item.status);
}

Deno.test('_itemStatus', () => {
	assertEquals('done', _itemStatus({status: 'done'}));
	assertEquals('todo', _itemStatus({status: 'todo'}));
	assertEquals(undefined, _itemStatus({}));
	assertEquals(undefined, _itemStatus({status: undefined}));
});

function isActiveStatus(status:string|undefined, itemId:string) : boolean|undefined {
	switch( status ) {
	case 'todo': case 'in-progress':
		return true;
	case 'done': case 'cancelled': case 'tabled':
		return false;
	case undefined:
		return undefined;
	default:
		console.warn(`Unrecognized status '${status}' on item '${itemId}'`);
		return undefined;
	}
}

// Item is 'active' / 'alive', may be considered to be worked on
// based on its own status and that of parents, but not taking
// dependencies into account.
function _itemIsActive(item:Item, items:Map<string,Item>, itemId:string) : boolean {
	const status = _itemStatus(item);

	// If the item is explicitly marked as active or not, return that
	const explicitlyActive = isActiveStatus(status, itemId);
	if( explicitlyActive != undefined ) return explicitlyActive;

	// Otherwise...check the parents
	const parentIds = strToList(item.subtaskOf);
	for( const parentId of parentIds ) {
		// If any parent is active, the item is active
		if( itemIsActive(parentId, items) ) return true;
	}

	// If the item has any parents, and none are active, then the item is inactive.
	// If it has no parents, then by default treat it as active.
	return parentIds.length == 0;
}

function itemIsActive(itemId:ItemID, items:Map<string, Item>) : boolean {
	const item = items.get(itemId);
	if( item == undefined ) throw new Error(`itemIsActive('${itemId}'): No such item`);
	return _itemIsActive(item, items, itemId);
}

const testItems = new Map<string,Item>([
	["TESTPROJECT-A", {
		status: "tabled (for now)"
	}],
	["TESTTASK-AA", {
		subtaskOf: "TESTPROJECT-A",
	}],
	["TESTTASK-AB", {
		subtaskOf: "TESTPROJECT-A",
		status: "todo",
	}],
	["TESTTASK-B", {
		subtaskOf: "",
	}],
	["TESTTASK-C", {
		subtaskOf: "",
		dependsOn: "TESTTASK-B",
	}],
	["TESTTASK-D", {
		subtaskOf: "",
		dependsOn: "TESTPROJECT-A",
		description: "Depends on a cancelled task; a funny edge case that should be reported!",
	}],
]);

Deno.test('itemIsActive(tabled item) = false', () => {
	assertFalse(itemIsActive("TESTPROJECT-A", testItems));
});
Deno.test('itemIsActive(subtask of tabled item) = false', () => {
	assertFalse(itemIsActive("TESTTASK-AA", testItems));
});
Deno.test('itemIsActive(explicitly "todo" subtask of tabled item) = true', () => {
	assert(itemIsActive("TESTTASK-AB", testItems));
});
Deno.test('itemIsActive(loose item) = true', () => {
	assert(itemIsActive("TESTTASK-B", testItems));
});
Deno.test('itemIsActive(loose item with dependency) = true', () => {
	assert(itemIsActive("TESTTASK-C", testItems));
});

// Item is ready to be worked on; this is true if it is 'active'
// (it and parent(s) are not 'cancelled'/'tabled'/'done')
// *and* it does not depend on any incomplete items.
function itemIsShovelReady(itemId:ItemID, items:Map<string, Item>) : boolean {
	const item = items.get(itemId);
	if( item == undefined ) throw new Error(`Item ${itemId} undefined`);
	
	if( !_itemIsActive(item, items, itemId) ) return false;
	
	// TODO: Anything with /any incomplete subtasks/ should be considered
	// not-shovel-ready also!
	// And we should probably annotate the objects
	// to make it obvious why we include it in the results when they are done
	// ("all subtasks complete: XXX-123, XXX-345, etc")
	
	for( const depId of strToList(item.dependsOn) ) {
		const dep = items.get(depId);
		if( dep == undefined ) throw new Error(`Item ${depId}, referenced by ${itemId}, undefined`);
		if( _itemStatus(dep) == 'done' ) {
			continue;
		}
		if( !_itemIsActive(dep, items, depId) ) {
			console.warn(`${itemId} depends on ${depId}, but that one is inactive without being marked 'done'!`);
		}
		return false;
	}

	return true;
}

Deno.test('itemIsShovelReady(tabled project) = false', () => {
	assertFalse(itemIsShovelReady("TESTPROJECT-A", testItems));
});
Deno.test('itemIsShovelReady(subtask of tabled project) = false', () => {
	assertFalse(itemIsShovelReady("TESTTASK-AA", testItems));
});
Deno.test('itemIsShovelReady(explicitly "todo" subtask of tabled project) = true', () => {
	assert(itemIsShovelReady("TESTTASK-AB", testItems));
});
Deno.test('itemIsShovelReady(loose task) = true', () => {
	assert(itemIsShovelReady("TESTTASK-B", testItems));
});
Deno.test('itemIsShovelReady(task depending on an incomplete task) = false', () => {
	assertFalse(itemIsShovelReady("TESTTASK-C", testItems));
});
Deno.test('itemIsShovelReady(task depending on a cancelled project) = false', () => {
	assertFalse(itemIsShovelReady("TESTTASK-D", testItems));
});


// TODO: Unit tests for itemIsComplete, itemIsShovelReady, etc.

async function processMain(options:ProcessToDoList) {
	const items : Map<string, Item> = new Map();
	for await( const entry of tefPiecesToEntries(tef.parseTefPieces(readerToIterable(Deno.stdin))) ) {
		const item = tefEntryToItem(entry);
		if( item.idString ) {
			items.set(item.idString, item);
		}
	}
	let itemIds : string[] = [];
	for( const [itemId, item] of items ) {
		if( options.selectionMode == "all" ) {
			itemIds.push(itemId);
		} else if( options.selectionMode == "shovel-ready" ) {
			if( itemIsShovelReady(itemId, items) ) {
				itemIds.push(itemId);
			}
		} else if( options.selectionMode == "random-shovel-ready-task" ) {
			if( item.typeString == "task" && itemIsShovelReady(itemId, items) ) {
				itemIds.push(itemId);
			}
		}
	}
	if( options.selectionMode == "random-shovel-ready-task" ) {
		itemIds.sort( (a,b) => a == b ? 0 : Math.random() < 0.5 ? -1 : 1 );
		if( itemIds.length == 0 ) {
			console.warn(`${selfName}: No tasks loaded; can't pick a random item from an empty list!`);
			return;
		} else {
			const taskId = itemIds[0];
			itemIds = [];
			collectItemAndParentIds(items, taskId, itemIds);
		}
	}
	
	if( options.outputFormat == "json" ) {
		for( const itemId of itemIds ) {
			console.log(JSON.stringify(items.get(itemId)));
		}
	} else {
		console.log();
		console.log(colors.yellow("Welcome to list-todo!"));
		console.log(`selection mode: ${options.selectionMode}`);
		console.log();
		console.log();
		console.log(separatorLine);
		for( const itemId of itemIds ) {
			console.log(separatorLine);
			console.log();
			const item = items.get(itemId)
			if( item ) {
				prettyPrintItem(item);
			} else {
				console.log(`Bad item ID: ${itemId}`);
			}
			console.log();
		}
		console.log(separatorLine);
		console.log(separatorLine);
		console.log();
		console.log();	
	}
}

const selfName = "list-todo";

function getBasicHelpText(selfName:string) : string {
	return (
		"Welcome to ListToDo27 help!\n" +
		"\n" +
		"This program reads a TEF file containing your to-do list on standard input\n" + 
		"and outputs selected items.  By default it just converts all items to JSON.\n" +
		"\n" +
		`Usage: ${selfName} -r ; shorthand for \`${selfName} --output-format=pretty --select=random-shovel-ready-task\`\n` +
		"  Do this if you want me to find a random 'shovel-ready' task (status is todo, all dependencies are done)\n" +
		`Usage: ${selfName} [--output-format={json|pretty}] [--select={all|random-shovel-ready-task|shovel-ready|\n` +
		"  Do this if you want...something else\n"
	);
}

function main(action:LTD27Action) : Promise<number> {
	if( action.actionName == "process" ) {
		return processMain(action).then( () => 0 );
	} else if( action.actionName == "show-help" ) {
		console.log(getBasicHelpText(selfName));
		console.log("Run with --more-help for more help.");
		return Promise.resolve(0);
	} else if( action.actionName == "show-more-help" ) {
		console.log(getBasicHelpText(selfName));
		console.log("The following 'status'es are recognized:");
		console.log("- todo         ; yet to be done (the default if no status is specified)");
		console.log("- in-progress  ; currently being worked on");
		console.log("- cancelled    ; let's ignore it forever");
		console.log("- tabled       ; let's ignore it for now");
		console.log("- done         ; it has been done");
		console.log();
		console.log("Entry format:");
		console.log("  =task MY-TASK-123");
		console.log("  title: My Super-Duper Task That I Plan To Finish Soon!");
		console.log("  created: 2023-09-15 ; because I was so bored lol");
		console.log("  subtask-of: MY-PROJECT-101");
		console.log("  depends-on: MY-TASK-102");
		console.log("  status: todo");
		console.log("  ");
		console.log("  This is a description of the task.");
		console.log("  It can contain multiple lines.");
		console.log("  ");
		console.log("  =task MY-TASK-234 - With Alternative Title Style");
		console.log("  ");
		console.log("  This one shows a more compact way to indicate title");
		console.log();
		console.log("Status lines may contain comments:");
		console.log("  status: done (2023-09-23) ; statuses are often followed by a date");
		console.log("  status: done ; semicolon is customary for starting commentary");
		console.log("  status: done # hash less so, but might be okay");
		return Promise.resolve(0);
	} else if( action.actionName == "complain-about-arguments" ) {
		for( const m of action.errorMessages ) {
			console.error(`${selfName}: Error: ${m}`);
		}
		console.error(`Try \`${selfName} --help\` for usage information`);
		return Promise.resolve(1);
	} else {
		console.error(`${selfName}: Error: Invalid action:`, action);
		return Promise.resolve(1);
	}
}

function parseOptions(args:string[]) : LTD27Action {
	let selectionMode : TaskStatusConstraintName = "all";
	let outputFormat : OutputFormatName = "json";

	for( const arg of args ) {
		if( arg == "--output-format=json" ) {
			outputFormat = "json";
		} else if( arg == "--output-format=pretty" ) {
			outputFormat = "pretty";
		} else if( arg == "-p" ) {
			outputFormat = "pretty";
			selectionMode = "random-shovel-ready-task";
		} else if( arg == "--select=all" ) {
			selectionMode = "all";
		} else if( arg == "--select=random-todo-task" || arg == "--select=random-shovel-ready-task" ) {
			// '--select=random-todo-task' for backward-combatibility yuk yuk; remove in v0.2.0
			selectionMode = "random-shovel-ready-task";
		} else if( arg == "--select=incomplete" || arg == "--select=shovel-ready" ) {
			selectionMode = "shovel-ready";
		} else if( arg == '--help' ) {
			return { actionName: "show-help" };
		} else if( arg == '--more-help' ) {
			return { actionName: "show-more-help" };
		} else {
			return {
				actionName: "complain-about-arguments",
				errorMessages: [`Error: unrecognized argument ${arg}`]
			}
		}
	}

	return {
		actionName: "process",
		selectionMode,
		outputFormat,
	}
}

if( import.meta.main ) {
	main(parseOptions(Deno.args));
}
