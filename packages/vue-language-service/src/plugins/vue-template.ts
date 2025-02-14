import * as shared from '@volar/shared';
import type * as ts2 from '@volar/typescript-language-service';
import { isIntrinsicElement } from '@volar/vue-code-gen';
import { parseScriptRanges } from '@volar/vue-code-gen/out/parsers/scriptRanges';
import { EmbeddedLanguageServicePlugin, useConfigurationHost } from '@volar/vue-language-service-types';
import { SearchTexts } from '@volar/vue-typescript';
import { camelize, capitalize, hyphenate } from '@vue/shared';
import type * as ts from 'typescript/lib/tsserverlibrary';
import * as path from 'upath';
import * as html from 'vscode-html-languageservice';
import * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type * as vueTs from '@volar/vue-typescript';
import { VueDocument, VueDocuments } from '../vueDocuments';
import useHtmlPlugin from './html';

export const semanticTokenTypes = [
	'componentTag',
];

// https://v3.vuejs.org/api/directives.html#v-on
const eventModifiers: Record<string, string> = {
	stop: 'call event.stopPropagation().',
	prevent: 'call event.preventDefault().',
	capture: 'add event listener in capture mode.',
	self: 'only trigger handler if event was dispatched from this element.',
	// {keyAlias}: 'only trigger handler on certain keys.',
	once: 'trigger handler at most once.',
	left: 'only trigger handler for left button mouse events.',
	right: 'only trigger handler for right button mouse events.',
	middle: 'only trigger handler for middle button mouse events.',
	passive: 'attaches a DOM event with { passive: true }.',
};

const vueGlobalDirectiveProvider = html.newHTMLDataProvider('vueGlobalDirective', {
	version: 1.1,
	tags: [],
	globalAttributes: [
		{ name: 'v-if' },
		{ name: 'v-else-if' },
		{ name: 'v-else', valueSet: 'v' },
		{ name: 'v-for' },
	],
});

interface HtmlCompletionData {
	mode: 'html',
	tsItem: vscode.CompletionItem | undefined,
}

interface AutoImportCompletionData {
	mode: 'autoImport',
	vueDocumentUri: string,
	importUri: string,
}

export default function useVueTemplateLanguagePlugin<T extends ReturnType<typeof useHtmlPlugin>>(options: {
	ts: typeof import('typescript/lib/tsserverlibrary'),
	getSemanticTokenLegend(): vscode.SemanticTokensLegend,
	getScanner(document: TextDocument): html.Scanner | undefined,
	tsLs: ts2.LanguageService,
	templateLanguagePlugin: T,
	isSupportedDocument: (document: TextDocument) => boolean,
	getNameCases?: (uri: string) => Promise<{
		tag: 'both' | 'kebabCase' | 'pascalCase',
		attr: 'kebabCase' | 'camelCase',
	}>,
	vueLsHost: vueTs.LanguageServiceHost,
	vueDocuments: VueDocuments,
	tsSettings: ts2.Settings,
}): EmbeddedLanguageServicePlugin & T {

	const componentCompletionDataCache = new WeakMap<
		Awaited<ReturnType<VueDocument['getTemplateData']>>,
		Map<string, { item: vscode.CompletionItem | undefined, bind: vscode.CompletionItem[], on: vscode.CompletionItem[]; }>
	>();
	const autoImportPositions = new WeakSet<vscode.Position>();
	const tokenTypes = new Map(options.getSemanticTokenLegend().tokenTypes.map((t, i) => [t, i]));
	const runtimeMode = options.vueLsHost.getVueCompilationSettings().experimentalRuntimeMode;

	return {

		...options.templateLanguagePlugin,

		complete: {

			triggerCharacters: [
				...options.templateLanguagePlugin.complete?.triggerCharacters ?? [],
				'@', // vue event shorthand
			],

			async on(document, position, context) {

				if (!options.isSupportedDocument(document))
					return;

				const vueDocument = options.vueDocuments.fromEmbeddedDocument(document);
				let tsItems: Awaited<ReturnType<typeof provideHtmlData>> | undefined;

				if (vueDocument) {
					tsItems = await provideHtmlData(vueDocument);
				}

				const htmlComplete = await options.templateLanguagePlugin.complete?.on?.(document, position, context);

				if (!htmlComplete)
					return;

				if (vueDocument && tsItems) {
					afterHtmlCompletion(htmlComplete, vueDocument, tsItems);
				}

				return htmlComplete;
			},

			async resolve(item) {

				const data: HtmlCompletionData | AutoImportCompletionData | undefined = item.data;

				if (data?.mode === 'html') {
					return await resolveHtmlItem(item, data);
				}
				else if (data?.mode === 'autoImport') {
					return await resolveAutoImportItem(item, data);
				}

				return item;
			},
		},

		doHover(document, position) {

			if (!options.isSupportedDocument(document))
				return;

			const vueDocument = options.vueDocuments.fromEmbeddedDocument(document);
			if (vueDocument) {
				options.templateLanguagePlugin.updateCustomData([]);
			}
			return options.templateLanguagePlugin.doHover?.(document, position);
		},

		async doValidation(document, options_2) {

			if (!options.isSupportedDocument(document))
				return;

			const originalResult = await options.templateLanguagePlugin.doValidation?.(document, options_2);
			const vueDocument = options.vueDocuments.fromEmbeddedDocument(document);

			if (vueDocument) {

				const templateErrors: vscode.Diagnostic[] = [];
				const sfcVueTemplateCompiled = vueDocument.file.getSfcVueTemplateCompiled();
				const sfcTemplateLanguageCompiled = vueDocument.file.getSfcTemplateLanguageCompiled();

				if (sfcVueTemplateCompiled && sfcTemplateLanguageCompiled) {

					for (const error of sfcVueTemplateCompiled.errors) {
						onCompilerError(error, vscode.DiagnosticSeverity.Error);
					}

					for (const warning of sfcVueTemplateCompiled.warnings) {
						onCompilerError(warning, vscode.DiagnosticSeverity.Warning);
					}

					function onCompilerError(error: NonNullable<typeof sfcVueTemplateCompiled>['errors'][number], severity: vscode.DiagnosticSeverity) {

						const templateHtmlRange = {
							start: error.loc?.start.offset ?? 0,
							end: error.loc?.end.offset ?? 0,
						};
						let sourceRange = sfcTemplateLanguageCompiled!.mapping(templateHtmlRange);
						let errorMessage = error.message;

						if (!sourceRange) {
							const htmlText = sfcTemplateLanguageCompiled!.html.substring(templateHtmlRange.start, templateHtmlRange.end);
							errorMessage += '\n```html\n' + htmlText.trim() + '\n```';
							sourceRange = { start: 0, end: 0 };
						}

						templateErrors.push({
							range: {
								start: document.positionAt(sourceRange.start),
								end: document.positionAt(sourceRange.end),
							},
							severity,
							code: error.code,
							source: 'vue',
							message: errorMessage,
						});
					}
				}

				return [
					...originalResult ?? [],
					...templateErrors,
				];
			}
		},

		async findDocumentSemanticTokens(document, range) {

			if (!options.isSupportedDocument(document))
				return;

			const result = await options.templateLanguagePlugin.findDocumentSemanticTokens?.(document, range) ?? [];
			const vueDocument = options.vueDocuments.fromEmbeddedDocument(document);
			const scanner = options.getScanner(document);

			if (vueDocument && scanner) {
				const templateScriptData = await vueDocument.getTemplateData();
				const components = new Set([
					...templateScriptData.components,
					...templateScriptData.components.map(hyphenate).filter(name => !isIntrinsicElement(runtimeMode, name)),
				]);
				const offsetRange = range ? {
					start: document.offsetAt(range.start),
					end: document.offsetAt(range.end),
				} : {
					start: 0,
					end: document.getText().length,
				};

				let token = scanner.scan();

				while (token !== html.TokenType.EOS) {

					const tokenOffset = scanner.getTokenOffset();

					// TODO: fix source map perf and break in while condition
					if (tokenOffset > offsetRange.end)
						break;

					if (tokenOffset >= offsetRange.start && (token === html.TokenType.StartTag || token === html.TokenType.EndTag)) {

						const tokenText = scanner.getTokenText();

						if (components.has(tokenText) || tokenText.indexOf('.') >= 0) {

							const tokenLength = scanner.getTokenLength();
							const tokenPosition = document.positionAt(tokenOffset);

							if (components.has(tokenText)) {
								result.push([tokenPosition.line, tokenPosition.character, tokenLength, tokenTypes.get('componentTag') ?? -1, 0]);
							}
						}
					}
					token = scanner.scan();
				}
			}

			return result;
		},

		resolveEmbeddedRange(range) {
			if (autoImportPositions.has(range.start) && autoImportPositions.has(range.end))
				return range;
		},
	};

	async function resolveHtmlItem(item: vscode.CompletionItem, data: HtmlCompletionData) {

		let tsItem = data.tsItem;

		if (!tsItem)
			return item;

		tsItem = await options.tsLs.doCompletionResolve(tsItem);
		item.tags = [...item.tags ?? [], ...tsItem.tags ?? []];

		const details: string[] = [];
		const documentations: string[] = [];

		if (item.detail) details.push(item.detail);
		if (tsItem.detail) details.push(tsItem.detail);
		if (details.length) {
			item.detail = details.join('\n\n');
		}

		if (item.documentation) documentations.push(typeof item.documentation === 'string' ? item.documentation : item.documentation.value);
		if (tsItem.documentation) documentations.push(typeof tsItem.documentation === 'string' ? tsItem.documentation : tsItem.documentation.value);
		if (documentations.length) {
			item.documentation = {
				kind: vscode.MarkupKind.Markdown,
				value: documentations.join('\n\n'),
			};
		}

		return item;
	}

	async function resolveAutoImportItem(item: vscode.CompletionItem, data: AutoImportCompletionData) {

		const _vueDocument = options.vueDocuments.get(data.vueDocumentUri);
		if (!_vueDocument)
			return item;

		const vueDocument = _vueDocument;
		const importFile = shared.uriToFsPath(data.importUri);
		const rPath = path.relative(options.vueLsHost.getCurrentDirectory(), importFile);
		const descriptor = vueDocument.file.getDescriptor();
		const scriptAst = vueDocument.file.getScriptAst();
		const scriptSetupAst = vueDocument.file.getScriptSetupAst();

		let importPath = path.relative(path.dirname(data.vueDocumentUri), data.importUri);
		if (!importPath.startsWith('.')) {
			importPath = './' + importPath;
		}

		if (!descriptor.scriptSetup && !descriptor.script) {
			item.detail = `Auto import from '${importPath}'\n\n${rPath}`;
			item.documentation = {
				kind: vscode.MarkupKind.Markdown,
				value: '[Error] `<script>` / `<script setup>` block not found.',
			};
			return item;
		}

		item.labelDetails = { description: rPath };

		const scriptImport = scriptAst ? getLastImportNode(scriptAst) : undefined;
		const scriptSetupImport = scriptSetupAst ? getLastImportNode(scriptSetupAst) : undefined;
		const componentName = capitalize(camelize(item.label.replace(/\./g, '-')));
		const textDoc = vueDocument.getDocument();
		const compiledVue = vueDocument.file.getCompiledVue()!;
		const insert = await getTypeScriptInsert() ?? getMonkeyInsert();
		if (insert.description) {
			item.detail = insert.description + '\n\n' + rPath;
		}
		if (descriptor.scriptSetup) {
			const startTagEnd = compiledVue.getSourceRange(descriptor.scriptSetup.startTagEnd)?.[0].start;
			if (startTagEnd !== undefined) {
				const editPosition = textDoc.positionAt(startTagEnd + (scriptSetupImport ? scriptSetupImport.end : 0));
				autoImportPositions.add(editPosition);
				item.additionalTextEdits = [
					vscode.TextEdit.insert(
						editPosition,
						'\n' + insert.insertText,
					),
				];
			}
		}
		else if (descriptor.script && scriptAst) {
			const startTagEnd = compiledVue.getSourceRange(descriptor.script.startTagEnd)?.[0].start;
			if (startTagEnd !== undefined) {
				const editPosition = textDoc.positionAt(startTagEnd + (scriptImport ? scriptImport.end : 0));
				autoImportPositions.add(editPosition);
				item.additionalTextEdits = [
					vscode.TextEdit.insert(
						editPosition,
						'\n' + insert.insertText,
					),
				];
				const scriptRanges = parseScriptRanges(options.ts, scriptAst, !!descriptor.scriptSetup, true, true);
				const exportDefault = scriptRanges.exportDefault;
				if (exportDefault) {
					// https://github.com/microsoft/TypeScript/issues/36174
					const printer = options.ts.createPrinter();
					if (exportDefault.componentsOption && exportDefault.componentsOptionNode) {
						const newNode: typeof exportDefault.componentsOptionNode = {
							...exportDefault.componentsOptionNode,
							properties: [
								...exportDefault.componentsOptionNode.properties,
								options.ts.factory.createShorthandPropertyAssignment(componentName),
							] as any as ts.NodeArray<ts.ObjectLiteralElementLike>,
						};
						const printText = printer.printNode(options.ts.EmitHint.Expression, newNode, scriptAst);
						const editRange = vscode.Range.create(
							textDoc.positionAt(startTagEnd + exportDefault.componentsOption.start),
							textDoc.positionAt(startTagEnd + exportDefault.componentsOption.end),
						);
						autoImportPositions.add(editRange.start);
						autoImportPositions.add(editRange.end);
						item.additionalTextEdits.push(vscode.TextEdit.replace(
							editRange,
							unescape(printText.replace(/\\u/g, '%u')),
						));
					}
					else if (exportDefault.args && exportDefault.argsNode) {
						const newNode: typeof exportDefault.argsNode = {
							...exportDefault.argsNode,
							properties: [
								...exportDefault.argsNode.properties,
								options.ts.factory.createShorthandPropertyAssignment(`components: { ${componentName} }`),
							] as any as ts.NodeArray<ts.ObjectLiteralElementLike>,
						};
						const printText = printer.printNode(options.ts.EmitHint.Expression, newNode, scriptAst);
						const editRange = vscode.Range.create(
							textDoc.positionAt(startTagEnd + exportDefault.args.start),
							textDoc.positionAt(startTagEnd + exportDefault.args.end),
						);
						autoImportPositions.add(editRange.start);
						autoImportPositions.add(editRange.end);
						item.additionalTextEdits.push(vscode.TextEdit.replace(
							editRange,
							unescape(printText.replace(/\\u/g, '%u')),
						));
					}
				}
			}
		}
		return item;

		async function getTypeScriptInsert() {
			const embeddedScriptUri = shared.fsPathToUri(vueDocument.file.getScriptFileName());
			const tsImportName = camelize(path.basename(importFile).replace(/\./g, '-'));
			const [formatOptions, preferences] = await Promise.all([
				options.tsSettings.getFormatOptions?.(embeddedScriptUri) ?? {},
				options.tsSettings.getPreferences?.(embeddedScriptUri) ?? {},
			]);
			const tsDetail = options.tsLs.__internal__.raw.getCompletionEntryDetails(shared.uriToFsPath(embeddedScriptUri), 0, tsImportName, formatOptions, importFile, preferences, undefined);
			if (tsDetail?.codeActions) {
				for (const action of tsDetail.codeActions) {
					for (const change of action.changes) {
						for (const textChange of change.textChanges) {
							if (textChange.newText.indexOf(`import ${tsImportName} `) >= 0) {
								return {
									insertText: textChange.newText.replace(`import ${tsImportName} `, `import ${componentName} `).trim(),
									description: action.description,
								};
							}
						}
					}
				}
			}
		}
		function getMonkeyInsert() {
			const anyImport = scriptSetupImport ?? scriptImport;
			let withSemicolon = true;
			let quote = '"';
			if (anyImport) {
				withSemicolon = anyImport.text.endsWith(';');
				quote = anyImport.text.includes("'") ? "'" : '"';
			}
			return {
				insertText: `import ${componentName} from ${quote}${importPath}${quote}${withSemicolon ? ';' : ''}`,
				description: '',
			};
		}
	}

	async function provideHtmlData(vueDocument: VueDocument) {

		const nameCases = await options.getNameCases?.(vueDocument.uri) ?? {
			tag: 'both',
			attr: 'kebabCase',
		};
		const componentCompletion = await getComponentCompletionData(vueDocument);
		const tags: html.ITagData[] = [];
		const tsItems = new Map<string, vscode.CompletionItem>();
		const globalAttributes: html.IAttributeData[] = [];

		for (const [_componentName, { item, bind, on }] of componentCompletion) {

			const componentNames =
				nameCases.tag === 'kebabCase' ? new Set([hyphenate(_componentName)])
					: nameCases.tag === 'pascalCase' ? new Set([_componentName])
						: new Set([hyphenate(_componentName), _componentName]);

			for (const componentName of componentNames) {

				const attributes: html.IAttributeData[] = componentName === '*' ? globalAttributes : [];

				for (const prop of bind) {

					const name = nameCases.attr === 'camelCase' ? prop.label : hyphenate(prop.label);

					if (hyphenate(name).startsWith('on-')) {

						const propNameBase = name.startsWith('on-')
							? name.slice('on-'.length)
							: (name['on'.length].toLowerCase() + name.slice('onX'.length));
						const propKey = createInternalItemId('componentEvent', [componentName, propNameBase]);

						attributes.push(
							{
								name: 'v-on:' + propNameBase,
								description: propKey,
							},
							{
								name: '@' + propNameBase,
								description: propKey,
							},
						);
						tsItems.set(propKey, prop);
					}
					else {

						const propName = name;
						const propKey = createInternalItemId('componentProp', [componentName, propName]);

						attributes.push(
							{
								name: propName,
								description: propKey,
							},
							{
								name: ':' + propName,
								description: propKey,
							},
							{
								name: 'v-bind:' + propName,
								description: propKey,
							},
						);
						tsItems.set(propKey, prop);
					}
				}
				for (const event of on) {

					const name = nameCases.attr === 'camelCase' ? event.label : hyphenate(event.label);
					const propKey = createInternalItemId('componentEvent', [componentName, name]);

					attributes.push({
						name: 'v-on:' + name,
						description: propKey,
					});
					attributes.push({
						name: '@' + name,
						description: propKey,
					});
					tsItems.set(propKey, event);
				}

				const componentKey = createInternalItemId('component', [componentName]);

				if (componentName !== '*') {
					tags.push({
						name: componentName,
						description: componentKey,
						attributes,
					});
				}

				if (item) {
					tsItems.set(componentKey, item);
				}
			}
		}

		const descriptor = vueDocument.file.getDescriptor();
		const enabledComponentAutoImport = await useConfigurationHost()?.getConfiguration<boolean>('volar.completion.autoImportComponent') ?? true;

		if (enabledComponentAutoImport && (descriptor.script || descriptor.scriptSetup)) {
			for (const vueDocument of options.vueDocuments.getAll()) {
				let baseName = path.removeExt(path.basename(vueDocument.uri), '.vue');
				if (baseName.toLowerCase() === 'index') {
					baseName = path.basename(path.dirname(vueDocument.uri));
				}
				baseName = baseName.replace(/\./g, '-');
				const componentName_1 = hyphenate(baseName);
				const componentName_2 = capitalize(camelize(baseName));
				let i: number | '' = '';
				if (componentCompletion.has(componentName_1) || componentCompletion.has(componentName_2)) {
					i = 1;
					while (componentCompletion.has(componentName_1 + i) || componentCompletion.has(componentName_2 + i)) {
						i++;
					}
				}
				tags.push({
					name: (nameCases.tag === 'kebabCase' ? componentName_1 : componentName_2) + i,
					description: createInternalItemId('importFile', [vueDocument.uri]),
					attributes: [],
				});
			}
		}

		const dataProvider = html.newHTMLDataProvider('vue-html', {
			version: 1.1,
			tags,
			globalAttributes,
		});

		options.templateLanguagePlugin.updateCustomData([
			vueGlobalDirectiveProvider,
			dataProvider,
		]);

		return tsItems;
	}

	function afterHtmlCompletion(completionList: vscode.CompletionList, vueDocument: VueDocument, tsItems: Map<string, vscode.CompletionItem>) {

		const replacement = getReplacement(completionList, vueDocument.getDocument());

		if (replacement) {

			const isEvent = replacement.text.startsWith('@') || replacement.text.startsWith('v-on:');
			const hasModifier = replacement.text.includes('.');

			if (isEvent && hasModifier) {

				const modifiers = replacement.text.split('.').slice(1);
				const textWithoutModifier = replacement.text.split('.')[0];

				for (const modifier in eventModifiers) {

					if (modifiers.includes(modifier))
						continue;

					const modifierDes = eventModifiers[modifier];
					const newItem: html.CompletionItem = {
						label: modifier,
						filterText: textWithoutModifier + '.' + modifier,
						documentation: modifierDes,
						textEdit: {
							range: replacement.textEdit.range,
							newText: textWithoutModifier + '.' + modifier,
						},
						kind: vscode.CompletionItemKind.EnumMember,
					};

					completionList.items.push(newItem);
				}
			}
		}

		for (const item of completionList.items) {

			const itemIdKey = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
			const itemId = itemIdKey ? readInternalItemId(itemIdKey) : undefined;

			if (itemId) {
				item.documentation = undefined;
			}

			if (itemId?.type === 'importFile') {

				const [fileUri] = itemId.args;
				const filePath = shared.uriToFsPath(fileUri);
				const rPath = path.relative(options.vueLsHost.getCurrentDirectory(), filePath);
				const data: AutoImportCompletionData = {
					mode: 'autoImport',
					vueDocumentUri: vueDocument.uri,
					importUri: fileUri,
				};
				item.labelDetails = { description: rPath };
				item.filterText = item.label + ' ' + rPath;
				item.detail = rPath;
				item.kind = vscode.CompletionItemKind.File;
				item.sortText = '\u0003' + (item.sortText ?? item.label);
				item.data = data;
			}
			else if (itemIdKey && itemId) {

				const tsItem = itemIdKey ? tsItems.get(itemIdKey) : undefined;

				if (itemId.type === 'componentProp' || itemId.type === 'componentEvent') {

					const [componentName] = itemId.args;

					if (componentName !== '*') {
						item.sortText = '\u0000' + (item.sortText ?? item.label);
					}

					if (tsItem) {
						if (itemId.type === 'componentProp') {
							item.kind = vscode.CompletionItemKind.Property;
						}
						else {
							item.kind = vscode.CompletionItemKind.Event;
						}
					}
				}
				else if (
					item.label === 'v-if'
					|| item.label === 'v-else-if'
					|| item.label === 'v-else'
					|| item.label === 'v-for'
				) {
					item.kind = vscode.CompletionItemKind.Method;
					item.sortText = '\u0003' + (item.sortText ?? item.label);
				}
				else if (item.label.startsWith('v-')) {
					item.kind = vscode.CompletionItemKind.Function;
					item.sortText = '\u0002' + (item.sortText ?? item.label);
				}
				else {
					item.sortText = '\u0001' + (item.sortText ?? item.label);
				}

				const data: HtmlCompletionData = {
					mode: 'html',
					tsItem: tsItem,
				};

				item.data = data;
			}
		}

		{
			const temp = new Map<string, vscode.CompletionItem>();

			for (const item of completionList.items) {

				const data: HtmlCompletionData | AutoImportCompletionData | undefined = item.data;

				if (data?.mode === 'autoImport' && data.importUri === vueDocument.uri) { // don't import itself
					continue;
				}

				if (!temp.get(item.label)?.documentation) { // filter HTMLAttributes
					temp.set(item.label, item);
				}
			}

			completionList.items = [...temp.values()];
		}

		options.templateLanguagePlugin.updateCustomData([]);
	}

	function getLastImportNode(ast: ts.SourceFile) {
		let importNode: ts.ImportDeclaration | undefined;
		ast.forEachChild(node => {
			if (options.ts.isImportDeclaration(node)) {
				importNode = node;
			}
		});
		return importNode ? {
			text: importNode.getFullText(ast).trim(),
			end: importNode.getEnd(),
		} : undefined;
	}

	async function getComponentCompletionData(sourceFile: VueDocument) {

		const templateData = await sourceFile.getTemplateData();

		let cache = componentCompletionDataCache.get(templateData);
		if (!cache) {

			cache = new Map<string, { item: vscode.CompletionItem | undefined, bind: vscode.CompletionItem[], on: vscode.CompletionItem[]; }>();

			const file = sourceFile.file.getAllEmbeddeds().find(e =>
				e.file.fileName.endsWith('.__VLS_template.tsx')
				|| e.file.fileName.endsWith('.__VLS_template.jsx')
			)?.file;
			const document = file ? sourceFile.embeddedDocumentsMap.get(file) : undefined;
			const templateTagNames = [...sourceFile.getTemplateTagsAndAttrs().tags.keys()];

			if (file && document) {

				const tags_1 = templateData.componentItems.map(item => {
					return { item, name: item.label };
				});
				const tags_2 = templateTagNames
					.filter(tag => tag.indexOf('.') >= 0)
					.map(tag => ({ name: tag, item: undefined }));

				for (const tag of [...tags_1, ...tags_2]) {

					if (cache.has(tag.name))
						continue;

					let bind: vscode.CompletionItem[] = [];
					let on: vscode.CompletionItem[] = [];
					{
						const searchText = SearchTexts.PropsCompletion(tag.name);
						let offset = file.content.indexOf(searchText);
						if (offset >= 0) {
							offset += searchText.length;
							try {
								bind = (await options.tsLs.doComplete(document.uri, document.positionAt(offset)))?.items
									.map(entry => { entry.label = entry.label.replace('?', ''); return entry; })
									.filter(entry => entry.kind !== vscode.CompletionItemKind.Text) ?? [];
							} catch { }
						}
					}
					{
						const searchText = SearchTexts.EmitCompletion(tag.name);
						let offset = file.content.indexOf(searchText);
						if (offset >= 0) {
							offset += searchText.length;
							try {
								on = (await options.tsLs.doComplete(document.uri, document.positionAt(offset)))?.items
									.map(entry => { entry.label = entry.label.replace('?', ''); return entry; })
									.filter(entry => entry.kind !== vscode.CompletionItemKind.Text) ?? [];
							} catch { }
						}
					}
					cache.set(tag.name, { item: tag.item, bind, on });
				}
				try {
					const offset = file.content.indexOf(SearchTexts.GlobalAttrs);
					const globalBind = (await options.tsLs.doComplete(document.uri, document.positionAt(offset)))?.items
						.map(entry => { entry.label = entry.label.replace('?', ''); return entry; })
						.filter(entry => entry.kind !== vscode.CompletionItemKind.Text) ?? [];
					cache.set('*', { item: undefined, bind: globalBind, on: [] });
				} catch { }
			}

			componentCompletionDataCache.set(templateData, cache);
		}

		return cache;
	}
}

function createInternalItemId(type: 'importFile' | 'vueDirective' | 'componentEvent' | 'componentProp' | 'component', args: string[]) {
	return '__VLS_::' + type + '::' + args.join(',');
}

function readInternalItemId(key: string) {
	if (key.startsWith('__VLS_::')) {
		const strs = key.split('::');
		return {
			type: strs[1] as 'importFile' | 'vueDirective' | 'componentEvent' | 'componentProp' | 'component',
			args: strs[2].split(','),
		};
	}
}

function getReplacement(list: html.CompletionList, doc: TextDocument) {
	for (const item of list.items) {
		if (item.textEdit && 'range' in item.textEdit) {
			return {
				item: item,
				textEdit: item.textEdit,
				text: doc.getText(item.textEdit.range)
			};
		}
	}
}
