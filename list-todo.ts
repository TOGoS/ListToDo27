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

import { assertEquals } from "https://deno.land/std@0.154.0/testing/asserts.ts";

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

function tefEntryToItem(e : Readonly<TEFEntry> ) : ItemEtc {
	// Might want to drive translation based on some schema.
	// Not yet sure exactly what that would look like.
	const trimIds = true;

	const obj : ItemEtc = {};

	// Parse ID string
	let effectiveIdString : string;
	let effectiveTitleString : string;
	let m;
	if( trimIds && (m = /^(\S+)\s+(?:-\s+|#\s+)?(.*)/.exec(e.idString)) ) {
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
		obj[ccKey] = value + header.value;
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



import * as colors from 'https://deno.land/std@0.154.0/fmt/colors.ts';

const separatorLine = colors.gray("#".repeat(74));

type ItemPrinter = (item:Item) => Promise<void>;

function collectItemAndParentIds(items:Map<string,Item>, itemId:string, into:string[]) {
	const item = items.get(itemId);
	if( item == undefined ) {
		throw new Error(`Referenced item ${itemId} not found in items map!`);
	}
	if( item.subtaskOf != undefined ) {
		const parentIds = item.subtaskOf.split(/,?\s+/);
		for( const parentId of parentIds ) {
			collectItemAndParentIds(items, parentId, into);
		}
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
interface ComplainAboutBadArguments {
	actionName : "complain-about-arguments";
	errorMessages : string[];
}
type LTD27Action = ProcessToDoList|ShowHelp|ComplainAboutBadArguments;

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

function itemIsDone(item:Item) : boolean {
	return /^done\b/.exec(item.status ?? 'todo') != null;
}

function itemIsShovelReady(itemId:ItemID, items:Map<string, Item>) : boolean {
	const item = items.get(itemId);
	if( item == undefined ) throw new Error(`Item ${itemId} undefined`);

	if( itemIsDone(item) ) return false;

	// TODO: Anything with /any incomplete subtasks/ should be considered
	// not-shovel-ready also!
	// And we should probably annotate the objects
	// to make it obvious why we include it in the results when they are done
	// ("all subtasks complete: XXX-123, XXX-345, etc")

	if( item.dependsOn ) {
		const dependencyIds = item.dependsOn.split(/[,\s]+/);
		for( const depId of dependencyIds ) {
			if( depId.length == 0 ) continue;
			const dep = items.get(depId);
			if( dep == undefined ) throw new Error(`Item ${depId}, referenced by ${itemId}, undefined`);
			if( !itemIsDone(dep) ) {
				return false;
			}
		}
	}

	return true;
}

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

function main(action:LTD27Action) : Promise<number> {
	if( action.actionName == "process" ) {
		return processMain(action).then( () => 0 );
	} else if( action.actionName == "show-help" ) {
		console.log("Welcome to ListToDo27 help!");
		console.log();
		console.log("This program reads a TEF file containing your to-do list on standard input");
		console.log("and outputs selected items.  By default it just converts all items to JSON.")
		console.log();
		console.log(`Usage: ${selfName} -r ; shorthand for \`${selfName} --output-format=pretty --select=random-shovel-ready-task\``);
		console.log("  Do this if you want me to find a random 'shovel-ready' task (status is todo, all dependencies are done)");
		console.log(`Usage: ${selfName} [--output-format={json|pretty}] [--select={all|random-shovel-ready-task|shovel-ready|`);
		console.log("  Do this if you want...something else");
		return Promise.resolve(0);
	} else if( action.actionName == "complain-about-arguments" ) {
		for( const m of action.errorMessages ) {
			console.error(`${selfName}: Error: ${m}`);
		}
		console.error(`Try \`${selfName} --help\` for usage information`);
		return Promise.resolve(1);
	} else {
		console.error(`${selfName}: Error: Invalid action: ${(action as any).actionName}`);
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
			return {
				actionName: "show-help"
			};
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
