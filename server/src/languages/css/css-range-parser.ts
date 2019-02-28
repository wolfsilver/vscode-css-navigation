import {TextDocument, Range} from 'vscode-languageserver'
import {timer} from '../../libs'
import {CSSService} from './css-service'


interface LeafName {
	raw: string
	full: string
	isSelector: boolean
}

interface LeafRange {
	names: LeafName[]
	start: number
	end: number
	parent: LeafRange | undefined
}

interface FullMainName {
	full: string
	main: string
}

export interface NamedRange {
	names: FullMainName[]
	range: Range
}

export class CSSRangeParser {

	private supportedLanguages = ['css', 'less', 'scss']
	private supportsNesting: boolean
	private document: TextDocument
	private languageId: string

	private stack: LeafRange[] = []
	private current: LeafRange | undefined
	private ignoreDeep: number = 0

	constructor(document: TextDocument) {
		//here mixed language and file extension, must makesure all languages supported are sames as file extensions
		//may needs to be modified if more languages added
		let {languageId} = document
		if (!this.supportedLanguages.includes(languageId)) {
			languageId = 'css'
			timer.log(`Language "${languageId}" is not a declared css language, using css language instead.`)
		}

		this.languageId = languageId
		this.supportsNesting = CSSService.isLanguageSupportsNesting(languageId)
		this.document = document
	}

	parse(): NamedRange[] {
		let text = this.document.getText()
		let ranges: LeafRange[] = []
		
		let re = /\s*(?:\/\/.*|\/\*[\s\S]*?\*\/|((?:\(.*?\)|".*?"|'.*?'|[\s\S])*?)([;{}]))/g
		/*
			\s* - match white spaces in left
			(?:
				\/\/.* - match comment line
				|
				\/\*[\s\S]*?\*\/ - match comment seagment
				|
				(?:
					\(.*?\) - (...), sass code may include @include fn(${name})
					".*?" - double quote string
					|
					'.*?' - double quote string
					|
					[\s\S] - others
				)*? - declaration or selector
				([;{}])
			)
		*/

		let match: RegExpExecArray | null

		while (match = re.exec(text)) {
			let selector = match[1]
			let endChar = match[2]

			if (endChar === '{' && selector) {
				selector = selector.trimRight().replace(/\s+/g, ' ')
				if (this.ignoreDeep > 0 || this.shouldIgnoreDeeply(selector)) {
					this.ignoreDeep++
				}
				
				this.current = this.newLeafRange(selector, re.lastIndex - selector.length - 1)
				ranges.push(this.current!)
			}
			else if (endChar === '}') {
				if (this.ignoreDeep > 0) {
					this.ignoreDeep--
				}

				if (this.current) {
					this.current.end = re.lastIndex

					if (this.supportsNesting) {
						this.current = this.stack.pop()
					}
				}
			}
		}

		if (this.current) {
			if (this.current.end === 0) {
				this.current.end = text.length
			}
		}

		return this.formatToNamedRanges(ranges)
	}

	private newLeafRange(selector: string, start: number): LeafRange {
		let names = this.parseToNames(selector)

		if (this.supportsNesting && this.ignoreDeep === 0 && this.current) {
			names = this.combineNestingNames(names)
		}

		let parent = this.current
		if (this.supportsNesting && parent) {
			this.stack.push(parent)
		}

		return {
			names,
			start,
			end: 0,
			parent
		}
	}

	private shouldIgnoreDeeply(declaration: string) {
		return declaration.startsWith('@keyframes')
	}

	//may selectors like this: '[attr="]"]', but we are not high strictly parser
	//if want to handle it, use /((?:\[(?:"(?:\\"|.)*?"|'(?:\\'|.)*?'|[\s\S])*?\]|\((?:"(?:\\"|.)*?"|'(?:\\'|.)*?'|[\s\S])*?\)|[\s\S])+?)(?:,|$)/g
	private parseToNames(selectors: string): LeafName[] {
		let match = selectors.match(/^@[\w-]+/)
		let names: LeafName[] = []
		if (match) {
			let command = match[0]
			
			if (this.languageId === 'scss' && command === '@at-root') {
				names.push({
					raw: command,
					full: command,
					isSelector: false
				})
				selectors = selectors.slice(command.length).trimLeft()
			}

			else {
				command = selectors
				names.push({
					raw: command,
					full: command,
					isSelector: false
				})
				return names
			}
		}

		let re = /((?:\[.*?\]|\(.*?\)|.)+?)(?:,|$)/gs
		/*
			(?:
				\[.*?\] - match [...]
				|
				\(.*?\) - match (...)
				|
				. - match other characters
			)
			+?
			(?:,|$) - if match ',' or '$', end
		*/

		while (match = re.exec(selectors)) {
			let name = match[1].trim()
			if (name) {
				names.push({
					raw: name,
					full: name,
					isSelector: this.ignoreDeep === 0
				})
			}
		}

		return names
	}

	private combineNestingNames(oldNames: LeafName[]): LeafName[] {
		let re = /(?<=^|[\s+>~])&/g	//has sass reference '&' if match
		let names:  LeafName[] = []
		let parentFullNames = this.getClosestSelectorTypeFullNames()

		for (let oldName of oldNames) {
			if (!oldName.isSelector) {
				names.push(oldName)
			}
			//not handle cross multiply when several '&' exist
			else if (parentFullNames && re.test(oldName.full)) {
				for (let parentFullName of parentFullNames) {
					let full = oldName.full.replace(re, parentFullName)
					names.push({full, raw: oldName.raw, isSelector: true})
				}
			}
			else if (parentFullNames) {
				for (let parentFullName of parentFullNames) {
					let full = parentFullName + ' ' + oldName.full
					names.push({full, raw: oldName.raw, isSelector: true})
				}
			}
			else {
				names.push(oldName)
			}
		}

		return names
	}

	private getClosestSelectorTypeFullNames(): string[] | null {
		let parent = this.current
		while (parent) {
			if (parent.names.length > 1 || parent.names[0] && parent.names[0].isSelector) {
				break
			}
			parent = parent.parent
		}
		if (!parent) {
			return null
		}
		
		let fullNames: string[] = []
		for (let name of parent.names) {
			if (name.isSelector) {
				fullNames.push(name.full)
			}
		}
		return fullNames
	}

	private formatToNamedRanges(leafRanges: LeafRange[]): NamedRange[] {
		let ranges: NamedRange[] = []

		for (let {names, start, end} of leafRanges) {
			ranges.push({
				names: names.map(name => this.formatLeafNameToFullMainName(name)),
				//positionAt use a binary search algorithm, it should be fast enough, no need to count lines here, although faster
				range: Range.create(this.document.positionAt(start), this.document.positionAt(end))
			})
		}

		return ranges
	}

	private formatLeafNameToFullMainName({raw, full, isSelector}: LeafName): FullMainName {
		if (!isSelector) {
			return {
				full,
				main: ''
			}
		}

		//if raw selector is like '&:...', ignore the main
		let shouldHaveMain = !this.hasSingleReferenceInRightMostDescendant(raw)
		
		return {
			full,
			main: shouldHaveMain ? this.getMainSelector(full) : ''
		}
	}

	//like '&:hover', 'a &:hover'
	private hasSingleReferenceInRightMostDescendant(selector: string): boolean {
		let rightMost = this.getRightMostDescendant(selector)
		return /^&(?:[^\w-]|$)/.test(rightMost)
	}

	/*
	it returns the start of the right most descendant
	e.g., selectors below wull returns '.a'
		.a[...]
		.a:actived
		.a::before
		.a.b
	*/
	private getMainSelector(selector: string): string {
		let rightMost = this.getRightMostDescendant(selector)
		if (!rightMost) {
			return ''
		}

		let match = rightMost.match(/^[#.]?\w[\w-]*/)
		if (!match) {
			return ''
		}

		let main = match[0]
		//if main is a tag selector, it must be at the start position
		if (/^[\w]/.test(main) && rightMost.length < selector.length) {
			return ''
		}

		return main
	}

	//the descendant combinator used to split ancestor and descendant: space > + ~
	//it's not a strict regexp, if want so, use /(?:\[(?:"(?:\\"|.)*?"|'(?:\\'|.)*?'|[^\]])*?+?\]|\((?:"(?:\\"|.)*?"|'(?:\\'|.)*?'|[^)])*?+?\)|[^\s>+~|])+?$/
	private getRightMostDescendant(selector: string): string {
		let descendantRE = /(?:\[[^\]]*?\]|\([^)]*?\)|[^\s+>~])+?$/
		/*
			(?:
				\[[^\]]+?\] - [...]
				|
				\([^)]+?\) - (...)
				|
				[^\s>+~] - others which are not descendant combinator
			)+? - must have ?, or the greedy mode will cause unnecessary exponential fallback
			$
		*/

		let match = selector.match(descendantRE)
		return match ? match[0] : ''
	}
}
