"use strict";

class _ParseStateTextCreature extends BaseParseStateText {
	constructor (
		{
			toConvert,
			options,
			entity,
		},
	) {
		super({toConvert, options, entity});

		this.additionalTypeTags = [];
	}

	addAdditionalTypeTag (val) {
		const toFind = val.toLowerCase();
		if (this.additionalTypeTags.some(it => it.toLowerCase() === toFind)) return;
		this.additionalTypeTags.push(val);
	}
}

// TODO easy improvements to be made:
//    - improve "broken line" fixing:
//      - across lines that end with: "Melee Weapon Attack:"
//      - creature's name breaking across multiple lines
//      - lines starting "DC" breaking across multiple lines
//      - lines starting with attack range e.g. "100/400 ft."
class CreatureParser extends BaseParser {
	static _NO_ABSORB_SUBTITLES = [
		"SAVING THROWS",
		"SKILLS",
		"DAMAGE VULNERABILITIES",
		"DAMAGE RESISTANCE",
		"DAMAGE IMMUNITIES",
		"CONDITION IMMUNITIES",
		"SENSES",
		"LANGUAGES",
		"CHALLENGE",
		"PROFICIENCY BONUS",
	];

	static _NO_ABSORB_TITLES = [
		"ACTION",
		"LEGENDARY ACTION",
		"VILLAIN ACTION", // homebrew
		"MYTHIC ACTION",
		"REACTION",
		"BONUS ACTION",
		"UTILITY SPELL", // homebrew
	];

	static _RE_START_SAVING_THROWS = "(?:Saving Throw|Save)s?";
	static _RE_START_SKILLS = "Skills?";
	static _RE_START_DAMAGE_VULN = "Damage Vulnerabilit(?:y|ies)";
	static _RE_START_DAMAGE_RES = "Damage Resistances?";
	static _RE_START_DAMAGE_IMM = "Damage Immunit(?:y|ies)";
	static _RE_START_CONDITION_IMM = "Condition Immunit(?:y|ies)";
	static _RE_START_SENSES = "Senses?";
	static _RE_START_LANGUAGES = "Languages?";
	static _RE_START_CHALLENGE = "Challenge";
	static _RE_START_PROF_BONUS = "Proficiency Bonus(?: \\(PB\\))?";

	static _LINE_MODES = {
		UNKNOWN: "unknown",
		TRAITS: "traits",
		ACTIONS: "actions",
		REACTIONS: "reactions",
		BONUS_ACTIONS: "bonusActions",
		LEGENDARY_ACTIONS: "legendaryActions",
		MYTHIC_ACTIONS: "mythicActions",
		BREW_FEATURES: "brewFeatures", // homebrew
	};

	/**
	 * If the current line ends in a comma, we can assume the next line is a broken/wrapped part of the current line
	 */
	static _absorbBrokenLine (
		{
			isCrLine,
			meta,
		},
	) {
		if (!meta.curLine) return false;

		if (isCrLine) return false; // avoid absorbing past the CR line

		const nxtLine = meta.toConvert[meta.ixToConvert + 1];
		if (!nxtLine) return false;

		if (ConvertUtil.isNameLine(nxtLine)) return false; // avoid absorbing the start of traits
		if (this._NO_ABSORB_TITLES.some(it => nxtLine.toUpperCase().includes(it))) return false;
		if (this._NO_ABSORB_SUBTITLES.some(it => nxtLine.toUpperCase().startsWith(it))) return false;

		meta.ixToConvert++;
		meta.curLine = `${meta.curLine.trim()} ${nxtLine.trim()}`;

		return true;
	}

	static _isStartNextLineParsingPhase ({line}) {
		return /^(?:action|legendary action|mythic action|reaction|bonus action)s?(?:\s+\([^)]+\))?$/i.test(line)
			// Homebrew
			|| /^(?:feature|villain action|utility spell)s?(?:\s+\([^)]+\))?$/i.test(line);
	}

	static _isNonMergeableEntryLine_noSentenceBreak ({line, lineNxt}) {
		return !/[.?!]$/.test(line.trim())
			&& /^(?:[A-Z]|\d+[ ,])/.test(lineNxt.trim());
	}

	/**
	 * Parses statblocks from raw text pastes
	 * @param inText Input text.
	 * @param options Options object.
	 * @param options.cbWarning Warning callback.
	 * @param options.cbOutput Output callback.
	 * @param options.isAppend Default output append mode.
	 * @param options.source Entity source.
	 * @param options.page Entity page.
	 * @param options.titleCaseFields Array of fields to be title-cased in this entity (if enabled).
	 * @param options.isTitleCase Whether title-case fields should be title-cased in this entity.
	 */
	static doParseText (inText, options) {
		options = this._getValidOptions(options);

		if (!inText || !inText.trim()) return options.cbWarning("No input!");
		const toConvert = this._getLinesToConvert({inText, options});

		const stats = {};
		stats.source = options.source || "";
		// for the user to fill out
		stats.page = options.page;

		const meta = new _ParseStateTextCreature({toConvert, options, entity: stats});

		meta.doPreLoop();
		// Pre step to handle CR/XP/etc. which has, due to awkward text flow, landed at the bottom of the statblock
		for (; meta.ixToConvert < meta.toConvert.length; meta.ixToConvert++) {
			meta.initCurLine();
			if (meta.isSkippableCurLine()) continue;
			if (this._doParseText_crAlt({meta, stats, cbWarning: options.cbWarning})) continue;
			if (this._doParseText_role({meta})) continue;
		}
		meta.doPostLoop();

		meta.doPreLoop();
		for (; meta.ixToConvert < meta.toConvert.length; meta.ixToConvert++) {
			meta.initCurLine();
			if (meta.isSkippableCurLine()) continue;

			// name of monster
			if (meta.ixToConvert === 0) {
				// region
				const mCr = /^(?<name>.*)\s+(?<cr>CR (?:\d+(?:\/\d+)?|[⅛¼½]) .*$)/.exec(meta.curLine);
				if (mCr) {
					meta.curLine = mCr.groups.name;
					meta.toConvert.splice(meta.ixToConvert + 1, 0, mCr.groups.cr);
				}
				// endregion

				stats.name = this._getAsTitle("name", meta.curLine, options.titleCaseFields, options.isTitleCase);
				// If the name is immediately repeated, skip it
				if ((meta.toConvert[meta.ixToConvert + 1] || "").trim() === meta.curLine) meta.toConvert.splice(meta.ixToConvert + 1, 1);
				continue;
			}

			// challenge rating alt
			if (this._doParseText_crAlt({meta, stats, cbWarning: options.cbWarning})) continue;

			// homebrew "role"
			if (this._doParseText_role({meta})) continue;

			// homebrew resources: "souls"
			if (this._RE_BREW_RESOURCE_SOULS.test(meta.curLine)) {
				this._brew_setResourceSouls(stats, meta, options);
				meta.toConvert.splice(meta.ixToConvert, 1);
				meta.ixToConvert--;
				continue;
			}

			// size type alignment
			if (meta.ixToConvert === 1) {
				this._setCleanSizeTypeAlignment(stats, meta, options);
				continue;
			}

			// armor class
			if (meta.ixToConvert === 2) {
				stats.ac = ConvertUtil.getStatblockLineHeaderText({reStartStr: "Armor Class", line: meta.curLine});
				continue;
			}

			// hit points
			if (meta.ixToConvert === 3) {
				this._setCleanHp(stats, meta.curLine);
				continue;
			}

			// speed
			if (meta.ixToConvert === 4) {
				this._setCleanSpeed(stats, meta.curLine, options);
				continue;
			}

			// ability scores
			if (/STR\s*DEX\s*CON\s*INT\s*WIS\s*CHA/i.test(meta.curLine)) {
				// skip forward a line and grab the ability scores
				++meta.ixToConvert;
				this._mutAbilityScoresFromSingleLine(stats, meta);
				continue;
			}

			// Alternate ability scores (all six abbreviations followed by all six scores, each on new lines)
			if (this._getSequentialAbilityScoreSectionLineCount(stats, meta) === 6) {
				meta.ixToConvert += this._getSequentialAbilityScoreSectionLineCount(stats, meta);
				this._mutAbilityScoresFromSingleLine(stats, meta);
				continue;
			}

			// Alternate ability scores (alternating lines of abbreviation and score)
			if (Parser.ABIL_ABVS.includes(meta.curLine.toLowerCase())) {
				// skip forward a line and grab the ability score
				++meta.ixToConvert;
				switch (meta.curLine.toLowerCase()) {
					case "str": stats.str = this._tryGetStat(meta.toConvert[meta.ixToConvert]); continue;
					case "dex": stats.dex = this._tryGetStat(meta.toConvert[meta.ixToConvert]); continue;
					case "con": stats.con = this._tryGetStat(meta.toConvert[meta.ixToConvert]); continue;
					case "int": stats.int = this._tryGetStat(meta.toConvert[meta.ixToConvert]); continue;
					case "wis": stats.wis = this._tryGetStat(meta.toConvert[meta.ixToConvert]); continue;
					case "cha": stats.cha = this._tryGetStat(meta.toConvert[meta.ixToConvert]); continue;
				}
			}

			// Alternate ability scores ()
			if (this._handleSpecialAbilityScores({stats, meta})) {
				continue;
			}

			// saves (optional)
			if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_SAVING_THROWS, line: meta.curLine})) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanSaves(stats, meta.curLine, options);
				continue;
			}

			// skills (optional)
			if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_SKILLS, line: meta.curLine})) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanSkills(stats, meta.curLine, options);
				continue;
			}

			// damage vulnerabilities (optional)
			if (
				ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_DAMAGE_VULN, line: meta.curLine})
			) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanDamageVuln(stats, meta.curLine, options);
				continue;
			}

			// damage resistances (optional)
			if (
				ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_DAMAGE_RES, line: meta.curLine})
			) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanDamageRes(stats, meta.curLine, options);
				continue;
			}

			// damage immunities (optional)
			if (
				ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_DAMAGE_IMM, line: meta.curLine})
			) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanDamageImm(stats, meta.curLine, options);
				continue;
			}

			// condition immunities (optional)
			if (
				ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_CONDITION_IMM, line: meta.curLine})
			) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanConditionImm(stats, meta.curLine, options);
				continue;
			}

			// senses
			if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_SENSES, line: meta.curLine})) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanSenses({stats, line: meta.curLine, cbWarning: options.cbWarning});
				continue;
			}

			// languages
			if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_LANGUAGES, line: meta.curLine})) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanLanguages(stats, meta.curLine);
				continue;
			}

			// challenge rating
			if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_CHALLENGE, line: meta.curLine})) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({isCrLine: true, meta}));
				this._setCleanCr(stats, meta, {cbWarning: options.cbWarning, header: this._RE_START_CHALLENGE});
				continue;
			}

			// proficiency bonus
			if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: this._RE_START_PROF_BONUS, line: meta.curLine})) {
				// noinspection StatementWithEmptyBodyJS
				while (this._absorbBrokenLine({meta}));
				this._setCleanPbNote(stats, meta.curLine);
				continue;
			}

			// traits
			stats.trait = [];
			stats.action = [];
			stats.reaction = [];
			stats.bonus = [];
			stats.legendary = [];
			stats.mythic = [];

			let curTrait = {};
			let lineMode = this._LINE_MODES.TRAITS;

			let isLegendaryDescription = false;
			let isMythicDescription = false;

			// Join together lines which are probably split over multiple lines of text
			for (let j = meta.ixToConvert; j < meta.toConvert.length; ++j) {
				let line = meta.toConvert[j];
				let lineNxt = meta.toConvert[j + 1];

				if (!lineNxt) continue;
				if (this._isStartNextLineParsingPhase({line}) || this._isStartNextLineParsingPhase({line: lineNxt})) continue;
				if (!this._isNonMergeableEntryLine_noSentenceBreak({line, lineNxt})) continue;

				if (ConvertUtil.isNameLine(lineNxt, {exceptions: new Set(["cantrips"]), splitterPunc: /(\.)/g})) {
					// If line+1 looks like a name line but has no content, and line+2 looks like a name line and *does*
					//   have content, then we assume that line+1 is actually part of the current entry as otherwise
					//   line+1 is a no-text entry.
					const lineNxtNxt = meta.toConvert[j + 2];
					const {entry: entryNxt} = ConvertUtil.splitNameLine(lineNxt);

					if (
						// If line+1 has an entry, it's a legitimate name line
						entryNxt?.trim()
						// If line+2 doesn't exist, line+1 is a legitimate name line
						|| !lineNxtNxt?.trim()
						// If line+2 is next phase, line+1 is a legitimate name line
						|| this._isStartNextLineParsingPhase({line: lineNxtNxt})
					) continue;

					if (!ConvertUtil.isNameLine(lineNxtNxt, {exceptions: new Set(["cantrips"]), splitterPunc: /(\.)/g})) continue;
				}

				// Avoid eating spellcasting `At Will: ...`
				const splColonNext = lineNxt.split(/(?::| -) /g).filter(Boolean);
				if (line.trim().endsWith(":") && splColonNext.length > 1 && /^[A-Z\d][\\/a-z]/.test(splColonNext[0].trim())) continue;

				meta.toConvert[j] = `${line.trim()} ${lineNxt.trim()}`;
				meta.toConvert.splice(j + 1, 1);
				if (j === meta.ixToConvert) meta.curLine = meta.toConvert[meta.ixToConvert];
				--j;
			}

			// keep going through traits til we hit actions
			while (meta.ixToConvert < meta.toConvert.length) {
				if (this._isStartNextLineParsingPhase({line: meta.curLine})) {
					lineMode = this._LINE_MODES.UNKNOWN;

					// Homebrew
					if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: "FEATURES?", line: meta.curLine.toUpperCase()})) lineMode = this._LINE_MODES.BREW_FEATURES;

					// Homebrew
					if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: "UTILITY SPELLS?", line: meta.curLine.toUpperCase()})) {
						lineMode = this._LINE_MODES.TRAITS;

						// Fake a spellcasting entry by adding a generic header
						const nxtLineMeta = meta.getNextLineMeta();
						if (nxtLineMeta) {
							meta.toConvert[nxtLineMeta.ixToConvertNext] = `Spellcasting (Utility). ${meta.toConvert[nxtLineMeta.ixToConvertNext]}`;
						}
					}

					if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: "ACTIONS?", line: meta.curLine.toUpperCase()})) lineMode = this._LINE_MODES.ACTIONS;
					if (lineMode === this._LINE_MODES.ACTIONS) {
						const mActionNote = /actions:?\s*\((.*?)\)/gi.exec(meta.curLine);
						if (mActionNote) stats.actionNote = mActionNote[1];
					}

					if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: "REACTIONS?", line: meta.curLine.toUpperCase()})) lineMode = this._LINE_MODES.REACTIONS;
					if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: "BONUS ACTIONS?", line: meta.curLine.toUpperCase()})) lineMode = this._LINE_MODES.BONUS_ACTIONS;

					if (
						ConvertUtil.isStatblockLineHeaderStart({reStartStr: "LEGENDARY ACTIONS?", line: meta.curLine.toUpperCase()})
						// Homebrew
						|| ConvertUtil.isStatblockLineHeaderStart({reStartStr: "VILLAIN ACTIONS?", line: meta.curLine.toUpperCase()})
					) lineMode = this._LINE_MODES.LEGENDARY_ACTIONS;
					isLegendaryDescription = lineMode === this._LINE_MODES.LEGENDARY_ACTIONS;

					if (ConvertUtil.isStatblockLineHeaderStart({reStartStr: "MYTHIC ACTIONS", line: meta.curLine.toUpperCase()})) lineMode = this._LINE_MODES.MYTHIC_ACTIONS;
					isMythicDescription = lineMode === this._LINE_MODES.MYTHIC_ACTIONS;

					meta.ixToConvert++;
					meta.curLine = meta.toConvert[meta.ixToConvert];
				}

				// Homebrew; ensure "Signature Attack (...). ..." features are always parsed as actions
				if (
					lineMode !== this._LINE_MODES.ACTIONS
					&& /^Signature Attack(?: \([^)]+\))?\./.test(meta.curLine)
				) {
					lineMode = this._LINE_MODES.ACTIONS;
				}

				// Handle reaction intro
				if (lineMode === this._LINE_MODES.REACTIONS) {
					if (/^[^.!?]+ can take (?:up to )?(two|three|four|five) reactions per round but only one per turn\.$/.test(meta.curLine)) {
						stats.reactionHeader = [
							meta.curLine,
						];
						meta.ixToConvert++;
						meta.curLine = meta.toConvert[meta.ixToConvert];
						continue;
					}
				}

				curTrait.name = "";
				curTrait.entries = [];

				if (isLegendaryDescription || isMythicDescription) {
					const compressed = meta.curLine.replace(/\s*/g, "").toLowerCase();

					if (isLegendaryDescription) {
						// usually the first paragraph is a description of how many legendary actions the creature can make
						// but in the case that it's missing the substring "legendary" and "action" it's probably an action
						if (!(compressed.includes("legendary") || compressed.includes("villain")) && !compressed.includes("action")) isLegendaryDescription = false;
					} else if (isMythicDescription) {
						// as above--mythic action headers include the text "legendary action"
						if (!compressed.includes("legendary") && !compressed.includes("action")) isLegendaryDescription = false;
					}
				}

				if (isLegendaryDescription) {
					curTrait.entries.push(meta.curLine.trim());
					isLegendaryDescription = false;
				} else if (isMythicDescription) {
					if (/mythic\s+trait/i.test(meta.curLine)) {
						stats.mythicHeader = [meta.curLine.trim()];
					} else {
						curTrait.entries.push(meta.curLine.trim());
					}
					isMythicDescription = false;
				} else {
					const {name, entry} = ConvertUtil.splitNameLine(meta.curLine);
					curTrait.name = name;
					curTrait.entries.push(entry);
				}

				meta.ixToConvert++;
				meta.curLine = meta.toConvert[meta.ixToConvert];

				// collect subsequent paragraphs
				while (meta.curLine && !ConvertUtil.isNameLine(meta.curLine, {exceptions: new Set(["cantrips"]), splitterPunc: /([.?!])/g}) && !this._isStartNextLineParsingPhase({line: meta.curLine})) {
					if (BaseParser._isContinuationLine(curTrait.entries, meta.curLine)) {
						curTrait.entries.last(`${curTrait.entries.last().trim()} ${meta.curLine.trim()}`);
					} else {
						curTrait.entries.push(meta.curLine.trim());
					}
					meta.ixToConvert++;
					meta.curLine = meta.toConvert[meta.ixToConvert];
				}

				if (curTrait.name || curTrait.entries) {
					// convert dice tags
					DiceConvert.convertTraitActionDice(curTrait);

					switch (lineMode) {
						case this._LINE_MODES.UNKNOWN: options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Discarded un-categorizable entry "${JSON.stringify(curTrait)}"!`); break;
						case this._LINE_MODES.TRAITS: if (this._hasEntryContent(curTrait)) stats.trait.push(curTrait); break;
						case this._LINE_MODES.ACTIONS: if (this._hasEntryContent(curTrait)) stats.action.push(curTrait); break;
						case this._LINE_MODES.REACTIONS: if (this._hasEntryContent(curTrait)) stats.reaction.push(curTrait); break;
						case this._LINE_MODES.BONUS_ACTIONS: if (this._hasEntryContent(curTrait)) stats.bonus.push(curTrait); break;
						case this._LINE_MODES.LEGENDARY_ACTIONS: if (this._hasEntryContent(curTrait)) stats.legendary.push(curTrait); break;
						case this._LINE_MODES.MYTHIC_ACTIONS: if (this._hasEntryContent(curTrait)) stats.mythic.push(curTrait); break;

						case this._LINE_MODES.BREW_FEATURES: {
							if (!this._hasEntryContent(curTrait)) break;
							const prop = this._getEntryProp({entry: curTrait});
							stats[prop].push(curTrait);
							break;
						}

						default: throw new Error(`Unhandled line mode "${lineMode}"!`);
					}
				}

				curTrait = {};
			}

			CreatureParser._PROPS_ENTRIES.forEach(prop => this._doMergeBulletedLists(stats, prop));
			CreatureParser._PROPS_ENTRIES.forEach(prop => this._doMergeNumberedLists(stats, prop));
			CreatureParser._PROPS_ENTRIES.forEach(prop => this._doMergeHangingLists(stats, prop));
			["action"].forEach(prop => this._doMergeBreathWeaponLists(stats, prop));
			["action"].forEach(prop => this._doMergeEyeRayLists(stats, prop));

			// Remove keys if they are empty
			if (stats.trait.length === 0) delete stats.trait;
			if (stats.action.length === 0) delete stats.action;
			if (stats.bonus.length === 0) delete stats.bonus;
			if (stats.reaction.length === 0) delete stats.reaction;
			if (stats.legendary.length === 0) delete stats.legendary;
			if (stats.mythic.length === 0) delete stats.mythic;
		}
		meta.doPostLoop();

		this._doCleanLegendaryActionHeader(stats);

		this._addExtraTypeTags(stats, meta);

		this._doStatblockPostProcess(stats, false, options);
		const statsOut = PropOrder.getOrdered(stats, "monster");
		options.cbOutput(statsOut, options.isAppend);
	}

	static _doParseText_crAlt ({meta, stats, cbWarning}) {
		if (!ConvertUtil.isStatblockLineHeaderStart({reStartStr: "CR", line: meta.curLine})) return false;

		// noinspection StatementWithEmptyBodyJS
		while (this._absorbBrokenLine({isCrLine: true, meta}));

		// Region merge following "<n> XP" line into CR line
		const lineNxt = meta.toConvert[meta.ixToConvert + 1];
		if (lineNxt && /^[\d,]+ XP$/.test(lineNxt)) {
			meta.curLine = `${meta.curLine.trim()} (${lineNxt.trim()})`;
			meta.toConvert[meta.ixToConvert] = meta.curLine;
			meta.toConvert.splice(meta.ixToConvert + 1, 1);
		}
		// endregion

		this._setCleanCr(stats, meta, {cbWarning, header: "CR"});

		// remove the line, as we expect alignment as line 1
		meta.toConvert.splice(meta.ixToConvert, 1);
		meta.ixToConvert--;

		return true;
	}

	static _doParseText_role ({meta}) {
		if (!["companion", "retainer"].includes(meta.curLine.toLowerCase())) return false;

		meta.addAdditionalTypeTag(meta.curLine.toTitleCase());

		// remove the line, as we expect alignment as line 1
		meta.toConvert.splice(meta.ixToConvert, 1);
		meta.ixToConvert--;

		return true;
	}

	static _getLinesToConvert ({inText, options}) {
		let clean = this._getCleanInput(inText, options);

		// region Handle bad OCR'ing of headers
		[
			"Legendary Actions?",
			"Villain Actions?",
			"Bonus Actions?",
			"Reactions?",
			"Actions?",
		]
			.map(it => ({re: new RegExp(`\\n\\s*${it.split("").join("\\s*")}\\s*\\n`, "g"), original: it.replace(/[^a-zA-Z ]/g, "")}))
			.forEach(({re, original}) => clean = clean.replace(re, `\n${original}\n`));
		// endregion

		// region Handle bad OCR'ing of dice
		clean = clean
			.replace(/\nl\/(?<unit>day)[.:]\s*/g, (...m) => `\n1/${m.last().unit}: `)
			.replace(/\b(?<num>[liI!]|\d+)?d[1liI!]\s*[oO0]\b/g, (...m) => `${m.last().num ? isNaN(m.last().num) ? "1" : m.last().num : ""}d10`)
			.replace(/\b(?<num>[liI!]|\d+)?d[1liI!]\s*2\b/g, (...m) => `${m.last().num ? isNaN(m.last().num) ? "1" : m.last().num : ""}d12`)
			.replace(/\b[liI!1]\s*d\s*(?<faces>\d+)\b/g, (...m) => `1d${m.last().faces}`)
			.replace(/\b(?<num>\d+)\s*d\s*(?<faces>\d+)\b/g, (...m) => `${m.last().num}d${m.last().faces}`)
		;
		// endregion

		// region Handle misc OCR issues
		clean = clean
			.replace(/\bI nt\b/g, "Int")
			.replace(/\(-[lI!]\)/g, "(-1)")
		;
		// endregion

		// Handle modifiers split across lines
		clean = clean
			.replace(/([-+] +)\n +(\d+|PB)/g, (...m) => `${m[1]}${m[2]}`)
		;

		// Handle CR XP on separate line
		clean = clean
			.replace(/\n(\([\d,]+ XP\)\n)/g, (...m) => m[1])
		;

		// region Split sentences which should *generally* in the same paragraph
		clean = clean
			// Handle split "DC-sentence then effect-sentence"
			.replace(/(\.\s*?)\n(On a (?:failed save|failure|success|successful save)\b)/g, (...m) => `${m[1].trimEnd()} ${m[2]}`)
			// Handle split "The target..." sentences
			.replace(/(\.\s*?)\n(The target (?:then|must|regains)\b)/g, (...m) => `${m[1].trimEnd()} ${m[2]}`)
			// Handle split "A creature..." sentences
			.replace(/(\.\s*?)\n(A creature (?:takes)\b)/g, (...m) => `${m[1].trimEnd()} ${m[2]}`)
		;
		// endregion

		clean = clean
			// Handle split `Melee Attack: ...`
			.replace(/((?:Melee|Ranged) (?:(?:Weapon|Spell|Area|Power) )?Attack:)\s*?\n\s*([-+])/g, (...m) => `${m[1]} ${m[2]}`)
			// Handle split `Hit: ... damage. If ...`
			.replace(/(Hit: [^.!?]+ damage(?: [^.!?]+)?[.!?])\s*?\n\s*(If)\b/g, (...m) => `${m[1].trimEnd()} ${m[2].trimStart()}`)
		;

		clean = clean
			// Homebrew spell action superscript
			// handle `commune\n+, ...`
			.replace(/([a-z]) *\n([ABR+], )/mg, (...m) => `${m[1]} ${m[2]}`)
			// handle `commune\n+\n`
			.replace(/([a-z]) *\n([ABR+])(\n|$)/mg, (...m) => `${m[1]} ${m[2]}${m[3]}`)
		;

		clean = clean
			// We don't expect any bare lines starting with parens
			.replace(/ *\n\(/, " (");

		const statsHeadFootSpl = clean.split(/(Challenge|Proficiency Bonus \(PB\))/i);

		statsHeadFootSpl[0] = statsHeadFootSpl[0]
			// collapse multi-line ability scores
			.replace(/^(?:\d\d?\s*\([-—+]?\d+\)\s*)+$/gim, (...m) => `${m[0].replace(/\n/g, " ").replace(/\s+/g, " ")}\n`);

		// (re-assemble after cleaning ability scores and) split into lines
		clean = statsHeadFootSpl.join("");

		// Re-clean after applying the above
		clean = this._getCleanInput(clean);

		let cleanLines = clean.split("\n").filter(it => it && it.trim());

		// Split apart "Challenge" and "Proficiency Bonus" if they are on the same line
		const ixChallengePb = cleanLines.findIndex(line => /^Challenge/.test(line.trim()) && /Proficiency Bonus/.test(line));
		if (~ixChallengePb) {
			let line = cleanLines[ixChallengePb];
			const [challengePart, pbLabel, pbRest] = line.split(/(Proficiency Bonus)/);
			cleanLines[ixChallengePb] = challengePart;
			cleanLines.splice(ixChallengePb + 1, 0, [pbLabel, pbRest].join(""));
		}

		return cleanLines;
	}

	static _handleSpecialAbilityScores ({stats, meta}) {
		const matches = [];

		let i = meta.ixToConvert;
		for (; i < meta.toConvert.length; ++i) {
			const l = meta.toConvert[i].trim();
			const m = new RegExp(`^${Parser.ABIL_ABVS.map(ab => `(?<${ab}>${ab.toUpperCase()}(?:, |\\b))?`).join("")}(?<text>.*)$`).exec(l);
			if (!m) break;
			if (!Parser.ABIL_ABVS.some(ab => m.groups[ab])) break;
			matches.push(m);
		}

		if (!matches.length) return false;

		matches
			.forEach(m => {
				Parser.ABIL_ABVS
					.forEach(ab => {
						if (!m.groups[ab]) return;
						stats[ab] = {special: m.groups.text.trim()};
					});
			});

		meta.ixToConvert += i - meta.ixToConvert;
		return true;
	}

	static _getEntryProp ({entry}) {
		if (typeof entry?.entries?.[0] !== "string") return "trait";
		const [str] = entry.entries;
		if (/\b(?:as a|can use (?:a|their)) bonus action\b/i.test(str)) return "bonus";
		if (/\b(?:as a|can use (?:a|their)) reaction\b/i.test(str)) return "reaction";
		if (/\b(?:(?:as|use) (an|their) action|takes the [A-Z][^.!?]+ action\b)\b/i.test(str)) return "action";
		// can use their reaction

		// Homebrew: for unclassified psionic powers, assume action by default
		if (/\b\d+(?:st|nd|rd|th)[-\u2012-\u2014]Order Power\b/.test(entry.name)) return "action";

		return "trait";
	}

	static _doCleanLegendaryActionHeader (stats) {
		if (!stats.legendary?.length) return;

		stats.legendary = stats.legendary
			.map(it => {
				if (!it.name.trim() && !it.entries.length) return null;

				const m = /can take (\d) legendary actions/gi.exec(it.entries[0]);
				if (!it.name.trim() && m) {
					if (m[1] !== "3") stats.legendaryActions = Number(m[1]);
					return null;
				}

				if (!it.name.trim() && it.entries[0].includes("villain")) {
					stats.legendaryHeader = it.entries;
					return null;
				}

				return it;
			})
			.filter(Boolean);
	}

	static _doMergeBulletedLists (stats, prop) {
		if (!stats[prop]) return;

		stats[prop]
			.forEach(block => {
				if (!block?.entries?.length) return;

				for (let i = 0; i < block.entries.length; ++i) {
					const curLine = block.entries[i];

					if (typeof curLine !== "string" || !curLine.trim().endsWith(":")) continue;

					let lst = null;
					let offset = 1;

					while (block.entries.length) {
						let nxtLine = block.entries[i + offset];

						if (typeof nxtLine !== "string" || !/^[•●]/.test(nxtLine.trim())) break;

						nxtLine = nxtLine.replace(/^[•●]\s*/, "");

						if (!lst) {
							lst = {type: "list", items: [nxtLine]};
							block.entries[i + offset] = lst;
							offset++;
						} else {
							lst.items.push(nxtLine);
							block.entries.splice(i + offset, 1);
						}
					}
				}
			});
	}

	static _mutAssignPrettyType ({obj, type}) {
		const tmp = {...obj};
		Object.keys(obj).forEach(k => delete obj[k]);
		obj.type = "item";
		Object.assign(obj, tmp);
	}

	static _doMergeNumberedLists (stats, prop) {
		if (!stats[prop]) return;

		for (let i = 0; i < stats[prop].length; ++i) {
			const cpyCur = MiscUtil.copyFast(stats[prop][i]);

			if (
				!(
					typeof cpyCur?.entries?.last() === "string"
					&& cpyCur?.entries?.last().trim().endsWith(":")
				)
			) continue;

			let lst = null;

			const slice = stats[prop].slice(i + 1);
			while (slice.length) {
				const cpyNxt = MiscUtil.copyFast(slice[0]);

				if (/^\d+(?:-\d+)?[.!?:] [A-Za-z]/.test(cpyNxt?.name || "")) {
					if (!lst) {
						lst = {type: "list", style: "list-hang-notitle", items: []};
						cpyCur.entries.push(lst);
					}

					this._mutAssignPrettyType({obj: cpyNxt, type: "item"});
					lst.items.push(cpyNxt);
					slice.shift();

					continue;
				}

				break;
			}

			// Ensure a list has a meaningful amount of items, or it's probably not a list
			if (lst == null || lst.items.length < 2) continue;

			stats[prop].splice(i + 1, lst.items.length);
			stats[prop][i].entries.push(lst);
		}
	}

	static _doMergeBreathWeaponLists (stats, prop) {
		if (!stats[prop]) return;

		for (let i = 0; i < stats[prop].length; ++i) {
			const cur = stats[prop][i];

			if (
				typeof cur?.entries?.last() === "string"
				&& cur?.entries?.last().trim().endsWith(":")
				&& cur?.entries?.last().trim().includes("following breath weapon")
			) {
				let lst = null;

				while (stats[prop].length) {
					const nxt = stats[prop][i + 1];

					if (/\bbreath\b/i.test(nxt?.name || "")) {
						if (!lst) {
							lst = {type: "list", style: "list-hang-notitle", items: []};
							cur.entries.push(lst);
						}

						this._mutAssignPrettyType({obj: nxt, type: "item"});
						lst.items.push(nxt);
						stats[prop].splice(i + 1, 1);

						continue;
					}

					break;
				}
			}
		}
	}

	static _doMergeEyeRayLists (stats, prop) {
		if (!stats[prop]) return;

		for (let i = 0; i < stats[prop].length; ++i) {
			const cur = stats[prop][i];

			if (
				/^eye (?:ray|psionic)s?/i.test(cur.name || "")
			) {
				let lst = null;

				while (stats[prop].length) {
					const nxt = stats[prop][i + 1];

					if (/^\d+\.\s+/i.test(nxt?.name || "")) {
						if (!lst) {
							lst = {type: "list", style: "list-hang-notitle", items: []};
							cur.entries.push(lst);
						}

						this._mutAssignPrettyType({obj: nxt, type: "item"});
						lst.items.push(nxt);
						stats[prop].splice(i + 1, 1);

						continue;
					}

					break;
				}
			}
		}
	}

	/**
	 * Merge together likely hanging lists. Note that this should be fairly conservative, as merging unwanted entries
	 * into the list is worse than not merging some list entries.
	 */
	static _doMergeHangingLists (stats, prop) {
		if (!stats[prop]) return;

		for (let i = 0; i < stats[prop].length; ++i) {
			const cur = stats[prop][i];

			if (typeof cur?.entries?.last() !== "string" || !cur?.entries?.last().trim().endsWith(":")) continue;

			const ptrList = {_: null};

			if (
				this._doMergeHangingLists_generic({
					stats,
					prop,
					ix: i,
					cur,
					ptrList,
					fnIsMatchCurEntry: cur => /\b(?:following( effects)?|their effects follow)[^.!?]*:/.test(cur.entries.last().trim()),
					fnIsMatchNxtStr: ({entryNxt, entryNxtStr}) => /\bthe target\b/i.test(entryNxtStr) && !entryNxt.name?.includes("("),
				})
			) continue;

			if (
				this._doMergeHangingLists_generic({
					stats,
					prop,
					ix: i,
					cur,
					ptrList,
					fnIsMatchCurEntry: cur => /\bfollowing effects of that Elemental's choice\b/.test(cur.entries.last().trim()),
					fnIsMatchNxtStr: ({entryNxt, entryNxtStr}) => /\b[Tt]he Elemental\b/i.test(entryNxtStr),
				})
			) continue;
		}
	}

	static _doMergeHangingLists_generic ({stats, prop, ix, cur, ptrList, fnIsMatchCurEntry, fnIsMatchNxtStr}) {
		if (!fnIsMatchCurEntry(cur)) return false;

		while (stats[prop].length) {
			const entryNxt = stats[prop][ix + 1];

			const entryNxtStr = entryNxt?.entries?.[0];
			if (!entryNxtStr || typeof entryNxtStr !== "string") break;

			if (!fnIsMatchNxtStr({entryNxt, entryNxtStr})) break;

			if (!ptrList._) {
				ptrList._ = {type: "list", style: "list-hang-notitle", items: []};
				cur.entries.push(ptrList._);
			}

			this._mutAssignPrettyType({obj: entryNxt, type: "item"});
			ptrList._.items.push(entryNxt);
			stats[prop].splice(ix + 1, 1);
		}

		return true;
	}

	/**
	 * Parses statblocks from Homebrewery/GM Binder Markdown
	 * @param inText Input text.
	 * @param options Options object.
	 * @param options.cbWarning Warning callback.
	 * @param options.cbOutput Output callback.
	 * @param options.isAppend Default output append mode.
	 * @param options.source Entity source.
	 * @param options.page Entity page.
	 * @param options.titleCaseFields Array of fields to be title-cased in this entity (if enabled).
	 * @param options.isTitleCase Whether title-case fields should be title-cased in this entity.
	 */
	static doParseMarkdown (inText, options) {
		options = this._getValidOptions(options);

		const isInlineLegendaryActionItem = (line) => /^-\s*\*\*\*?[^*]+/gi.test(line.trim());

		if (!inText || !inText.trim()) return options.cbWarning("No input!");
		const toConvert = this._getCleanInput(inText, options).split("\n");
		let stats = null;

		const getNewStatblock = () => {
			return {
				source: options.source,
				page: options.page,
			};
		};

		let step = 0;
		let hasMultipleBlocks = false;
		const doOutputStatblock = () => {
			if (trait != null) doAddFromParsed();
			if (stats) {
				this._addExtraTypeTags(stats, meta);
				this._doStatblockPostProcess(stats, true, options);
				const statsOut = PropOrder.getOrdered(stats, "monster");
				options.cbOutput(statsOut, options.isAppend);
			}
			stats = getNewStatblock();
			if (hasMultipleBlocks) options.isAppend = true; // append any further blocks we find in this parse
			step = 0;
		};

		let isPrevBlank = true;
		let nextPrevBlank = true;
		let trait = null;

		const getCleanLegendaryActionText = (line) => {
			return ConverterUtilsMarkdown.getCleanTraitText(line.trim().replace(/^-\s*/, ""));
		};

		const doAddFromParsed = () => {
			if (step === 9) { // traits
				doAddTrait();
			} else if (step === 10) { // actions
				doAddAction();
			} else if (step === 11) { // reactions
				doAddReaction();
			} else if (step === 12) { // bonus actions
				doAddBonusAction();
			} else if (step === 13) { // legendary actions
				doAddLegendary();
			} else if (step === 14) { // mythic actions
				doAddMythic();
			}
		};

		const _doAddGenericAction = (prop) => {
			if (this._hasEntryContent(trait)) {
				stats[prop] = stats[prop] || [];

				DiceConvert.convertTraitActionDice(trait);
				stats[prop].push(trait);
			}
			trait = null;
		};

		const doAddTrait = () => _doAddGenericAction("trait");
		const doAddAction = () => _doAddGenericAction("action");
		const doAddReaction = () => _doAddGenericAction("reaction");
		const doAddBonusAction = () => _doAddGenericAction("bonus");
		const doAddLegendary = () => _doAddGenericAction("legendary");
		const doAddMythic = () => _doAddGenericAction("mythic");

		// TODO(Future) create and switch to a `_ParseMetaMarkdownCreature`; factor shared to mixin
		const meta = new _ParseStateTextCreature({toConvert});

		for (let i = 0; i < meta.toConvert.length; i++) {
			let curLineRaw = ConverterUtilsMarkdown.getCleanRaw(meta.toConvert[i]);
			meta.curLine = curLineRaw;

			if (ConverterUtilsMarkdown.isBlankLine(curLineRaw)) {
				isPrevBlank = true;
				continue;
			} else nextPrevBlank = false;
			meta.curLine = this._stripMarkdownQuote(meta.curLine);

			if (ConverterUtilsMarkdown.isBlankLine(meta.curLine)) continue;
			else if (
				(meta.curLine === "___" && isPrevBlank) // handle nicely separated blocks
				|| curLineRaw === "___" // handle multiple stacked blocks
			) {
				if (stats !== null) hasMultipleBlocks = true;
				doOutputStatblock();
				isPrevBlank = nextPrevBlank;
				continue;
			} else if (meta.curLine === "___") {
				isPrevBlank = nextPrevBlank;
				continue;
			}

			// name of monster
			if (step === 0) {
				meta.curLine = ConverterUtilsMarkdown.getNoHashes(meta.curLine);
				stats.name = this._getAsTitle("name", meta.curLine, options.titleCaseFields, options.isTitleCase);
				step++;
				continue;
			}

			// size type alignment
			if (step === 1) {
				meta.curLine = meta.curLine.replace(/^\**(.*?)\**$/, "$1");
				this._setCleanSizeTypeAlignment(stats, meta, options);
				step++;
				continue;
			}

			// armor class
			if (step === 2) {
				stats.ac = ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine).replace(/Armor Class/g, "").trim();
				step++;
				continue;
			}

			// hit points
			if (step === 3) {
				this._setCleanHp(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine));
				step++;
				continue;
			}

			// speed
			if (step === 4) {
				this._setCleanSpeed(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), options);
				step++;
				continue;
			}

			// ability scores
			if (step === 5 || step === 6 || step === 7) {
				// skip the two header rows
				if (meta.curLine.replace(/\s*/g, "").startsWith("|STR") || meta.curLine.replace(/\s*/g, "").startsWith("|:-")) {
					step++;
					continue;
				}
				const abilities = meta.curLine.split("|").map(it => it.trim()).filter(Boolean);
				Parser.ABIL_ABVS.map((abi, j) => stats[abi] = this._tryGetStat(abilities[j]));
				step++;
				continue;
			}

			if (step === 8) {
				// saves (optional)
				if (~meta.curLine.indexOf("Saving Throws")) {
					this._setCleanSaves(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), options);
					continue;
				}

				// skills (optional)
				if (~meta.curLine.indexOf("Skills")) {
					this._setCleanSkills(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), options);
					continue;
				}

				// damage vulnerabilities (optional)
				if (~meta.curLine.indexOf("Damage Vulnerabilities")) {
					this._setCleanDamageVuln(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), options);
					continue;
				}

				// damage resistances (optional)
				if (~meta.curLine.indexOf("Damage Resistance")) {
					this._setCleanDamageRes(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), options);
					continue;
				}

				// damage immunities (optional)
				if (~meta.curLine.indexOf("Damage Immunities")) {
					this._setCleanDamageImm(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), options);
					continue;
				}

				// condition immunities (optional)
				if (~meta.curLine.indexOf("Condition Immunities")) {
					this._setCleanConditionImm(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), options);
					continue;
				}

				// senses
				if (~meta.curLine.indexOf("Senses")) {
					this._setCleanSenses({stats, line: ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine), cbWarning: options.cbWarning});
					continue;
				}

				// languages
				if (~meta.curLine.indexOf("Languages")) {
					this._setCleanLanguages(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine));
					continue;
				}

				// CR
				if (~meta.curLine.indexOf("Challenge")) {
					meta.curLine = ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine);
					this._setCleanCr(stats, meta, {cbWarning: options.cbWarning});
					continue;
				}

				// PB
				if (~meta.curLine.indexOf("Proficiency Bonus")) {
					this._setCleanPbNote(stats, ConverterUtilsMarkdown.getNoDashStarStar(meta.curLine));
					continue;
				}

				const [nextLine1, nextLine2] = this._getNextLinesMarkdown(meta, {ixCur: i, isPrevBlank, nextPrevBlank}, 2);

				// Skip past Giffyglyph builder junk
				if (nextLine1 && nextLine2 && ~nextLine1.indexOf("Attacks") && ~nextLine2.indexOf("Attack DCs")) {
					i = this._advanceLinesMarkdown(meta, {ixCur: i, isPrevBlank, nextPrevBlank}, 2);
				}

				step++;
			}

			const cleanedLine = ConverterUtilsMarkdown.getNoTripleHash(meta.curLine);
			if (cleanedLine.toLowerCase() === "actions") {
				doAddFromParsed();
				step = 10;
				continue;
			} else if (cleanedLine.toLowerCase() === "reactions") {
				doAddFromParsed();
				step = 11;
				continue;
			} else if (cleanedLine.toLowerCase() === "bonus actions") {
				doAddFromParsed();
				step = 12;
				continue;
			} else if (cleanedLine.toLowerCase() === "legendary actions") {
				doAddFromParsed();
				step = 13;
				continue;
			} else if (cleanedLine.toLowerCase() === "mythic actions") {
				doAddFromParsed();
				step = 14;
				continue;
			}

			// traits
			if (step === 9) {
				if (ConverterUtilsMarkdown.isInlineHeader(meta.curLine)) {
					doAddTrait();
					trait = {name: "", entries: []};
					const [name, text] = ConverterUtilsMarkdown.getCleanTraitText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else {
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine));
				}
			}

			// actions
			if (step === 10) {
				if (ConverterUtilsMarkdown.isInlineHeader(meta.curLine)) {
					doAddAction();
					trait = {name: "", entries: []};
					const [name, text] = ConverterUtilsMarkdown.getCleanTraitText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else {
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine));
				}
			}

			// reactions
			if (step === 11) {
				if (ConverterUtilsMarkdown.isInlineHeader(meta.curLine)) {
					doAddReaction();
					trait = {name: "", entries: []};
					const [name, text] = ConverterUtilsMarkdown.getCleanTraitText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else {
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine));
				}
			}

			// bonus actions
			if (step === 12) {
				if (ConverterUtilsMarkdown.isInlineHeader(meta.curLine)) {
					doAddBonusAction();
					trait = {name: "", entries: []};
					const [name, text] = ConverterUtilsMarkdown.getCleanTraitText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else {
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine));
				}
			}

			// legendary actions
			if (step === 13) {
				if (isInlineLegendaryActionItem(meta.curLine)) {
					doAddLegendary();
					trait = {name: "", entries: []};
					const [name, text] = getCleanLegendaryActionText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else if (ConverterUtilsMarkdown.isInlineHeader(meta.curLine)) {
					doAddLegendary();
					trait = {name: "", entries: []};
					const [name, text] = ConverterUtilsMarkdown.getCleanTraitText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else {
					if (!trait) { // legendary action intro text
						// ignore generic LA intro; the renderer will insert it
						if (!meta.curLine.toLowerCase().includes("can take 3 legendary actions")) {
							trait = {name: "", entries: [ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine)]};
						}
					} else trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine));
				}
			}

			// mythic actions
			if (step === 14) {
				if (isInlineLegendaryActionItem(meta.curLine)) {
					doAddMythic();
					trait = {name: "", entries: []};
					const [name, text] = getCleanLegendaryActionText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else if (ConverterUtilsMarkdown.isInlineHeader(meta.curLine)) {
					doAddMythic();
					trait = {name: "", entries: []};
					const [name, text] = ConverterUtilsMarkdown.getCleanTraitText(meta.curLine);
					trait.name = name;
					trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(text));
				} else {
					if (!trait) { // mythic action intro text
						if (meta.curLine.toLowerCase().includes("mythic trait is active")) {
							stats.mythicHeader = [ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine)];
						}
					} else trait.entries.push(ConverterUtilsMarkdown.getNoLeadingSymbols(meta.curLine));
				}
			}
		}

		doOutputStatblock();
	}

	static _stripMarkdownQuote (line) {
		return line.replace(/^\s*>\s*/, "").trim();
	}

	static _callOnNextLinesMarkdown (meta, {ixCur, isPrevBlank, nextPrevBlank}, numLines, fn) {
		const len = meta.toConvert.length;

		for (let i = ixCur + 1; i < len; ++i) {
			const line = meta.toConvert[i];

			if (ConverterUtilsMarkdown.isBlankLine(line)) {
				isPrevBlank = true;
				continue;
			} else nextPrevBlank = false;

			const cleanLine = this._stripMarkdownQuote(line);

			if (ConverterUtilsMarkdown.isBlankLine(cleanLine)) continue;
			else if (
				(cleanLine === "___" && isPrevBlank) // handle nicely separated blocks
				|| line === "___" // handle multiple stacked blocks
			) {
				break;
			} else if (cleanLine === "___") {
				isPrevBlank = nextPrevBlank;
				continue;
			}

			fn(cleanLine, i);

			if (!--numLines) break;
		}
	}

	static _getNextLinesMarkdown (meta, {ixCur, isPrevBlank, nextPrevBlank}, numLines) {
		const out = [];
		const fn = cleanLine => out.push(cleanLine);
		this._callOnNextLinesMarkdown(meta, {ixCur, isPrevBlank, nextPrevBlank}, numLines, fn);
		return out;
	}

	static _advanceLinesMarkdown (meta, {ixCur, isPrevBlank, nextPrevBlank}, numLines) {
		let ixOut = ixCur + 1;
		const fn = (_, i) => ixOut = i + 1;
		this._callOnNextLinesMarkdown(meta, {ixCur, isPrevBlank, nextPrevBlank}, numLines, fn);
		return ixOut;
	}

	// SHARED UTILITY FUNCTIONS ////////////////////////////////////////////////////////////////////////////////////////
	static _doStatblockPostProcess (stats, isMarkdown, options) {
		this._doFilterAddSpellcasting(stats, "trait", isMarkdown, options);
		this._doFilterAddSpellcasting(stats, "action", isMarkdown, options);
		if (stats.trait) stats.trait.forEach(it => RechargeConvert.tryConvertRecharge(it, () => {}, () => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Manual recharge tagging required for trait "${it.name}"`)));
		if (stats.action) stats.action.forEach(it => RechargeConvert.tryConvertRecharge(it, () => {}, () => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Manual recharge tagging required for action "${it.name}"`)));
		if (stats.bonus) stats.bonus.forEach(it => RechargeConvert.tryConvertRecharge(it, () => {}, () => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Manual recharge tagging required for bonus action "${it.name}"`)));
		CreatureParser._PROPS_ENTRIES.filter(prop => stats[prop]).forEach(prop => SpellTag.tryRun(stats[prop]));
		AcConvert.tryPostProcessAc(
			stats,
			(ac) => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}AC "${ac}" requires manual conversion`),
			(ac) => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Failed to parse AC "${ac}"`),
		);
		TagAttack.tryTagAttacks(stats, (atk) => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Manual attack tagging required for "${atk}"`));
		TagHit.tryTagHits(stats);
		TagDc.tryTagDcs(stats);
		TagCondition.tryTagConditions(stats, {isTagInflicted: true});
		TagCondition.tryTagConditionsSpells(
			stats,
			{
				cbMan: (sp) => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Spell "${sp}" could not be found during condition tagging`),
				isTagInflicted: true,
			},
		);
		TagCondition.tryTagConditionsRegionalsLairs(
			stats,
			{
				cbMan: (legendaryGroup) => options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Legendary group "${legendaryGroup.name} :: ${legendaryGroup.source}" could not be found during condition tagging`),
				isTagInflicted: true,
			},
		);
		TraitActionTag.tryRun(stats);
		LanguageTag.tryRun(stats);
		SenseFilterTag.tryRun(stats);
		SpellcastingTypeTag.tryRun(stats);
		DamageTypeTag.tryRun(stats);
		DamageTypeTag.tryRunSpells(stats);
		DamageTypeTag.tryRunRegionalsLairs(stats);
		CreatureSavingThrowTagger.tryRun(stats);
		CreatureSavingThrowTagger.tryRunSpells(stats);
		CreatureSavingThrowTagger.tryRunRegionalsLairs(stats);
		MiscTag.tryRun(stats);
		DetectNamedCreature.tryRun(stats);
		TagImmResVulnConditional.tryRun(stats);
		DragonAgeTag.tryRun(stats);
		AttachedItemTag.tryRun(stats);
		this._doStatblockPostProcess_doCleanup(stats, options);
	}

	static _doFilterAddSpellcasting (stats, prop, isMarkdown, options) {
		if (!stats[prop]) return;
		const spellcasting = [];
		stats[prop] = stats[prop].map(ent => {
			if (!ent.name || !ent.name.toLowerCase().includes("spellcasting")) return ent;
			const parsed = SpellcastingTraitConvert.tryParseSpellcasting(ent, {isMarkdown, cbErr: options.cbErr, displayAs: prop, actions: stats.action, reactions: stats.reaction});
			if (!parsed) return ent;
			spellcasting.push(parsed);
			return null;
		}).filter(Boolean);
		if (spellcasting.length) stats.spellcasting = [...stats.spellcasting || [], ...spellcasting];
	}

	static _doStatblockPostProcess_doCleanup (stats, options) {
		// remove any empty arrays
		Object.keys(stats).forEach(k => {
			if (stats[k] instanceof Array && stats[k].length === 0) {
				delete stats[k];
			}
		});
	}

	static _tryConvertNumber (strNumber) {
		try {
			return Number(strNumber.replace(/—/g, "-"));
		} catch (e) {
			return strNumber;
		}
	}

	static _tryParseType ({stats, strType}) {
		strType = strType.trim().toLowerCase();
		const mSwarm = /^(?<prefix>.*)swarm of (?<size>\w+) (?<type>\w+)(?: \((?<tags>[^)]+)\))?$/i.exec(strType);
		if (mSwarm) {
			const swarmTypeSingular = Parser.monTypeFromPlural(mSwarm[3]);

			const out = { // retain any leading junk, as we'll parse it out in a later step
				type: `${mSwarm.groups.prefix}${swarmTypeSingular}`,
				swarmSize: mSwarm.groups.size[0].toUpperCase(),
			};

			if (mSwarm.groups.tags) out.tags = this._tryParseType_getTags({str: mSwarm.groups.tags});

			return out;
		}

		const mParens = /^(.*?) (\(.*?\))\s*$/.exec(strType);
		let type, tags, note;

		if (mParens) {
			// If there are multiple sizes, assume bracketed text is a note referring to this
			if (stats.size.length > 1) {
				note = mParens[2];
			} else {
				tags = this._tryParseType_getTags({str: mParens[2]});
			}
			strType = mParens[1];
		}

		if (/ or /.test(strType)) {
			const pts = strType.split(/(?:, |,? or )/g);
			type = {
				choose: pts.map(it => it.trim()).filter(Boolean),
			};
		}

		if (!type) type = strType;

		if (typeof type === "string" && !tags && !note) return type;

		const out = {type};
		if (tags) out.tags = tags;
		if (note) out.note = note;

		return out;
	}

	static _tryParseType_getTags ({str}) {
		return str.split(",").map(s => s.replace(/\(/g, "").replace(/\)/g, "").trim());
	}

	static _getSequentialAbilityScoreSectionLineCount (stats, meta) {
		if (stats.str != null) return false; // Skip if we already have ability scores

		let cntLines = 0;
		const nextSixLines = [];
		for (let i = meta.ixToConvert; nextSixLines.length < 6; ++i) {
			const line = (meta.toConvert[i] || "").toLowerCase();
			if (Parser.ABIL_ABVS.includes(line)) nextSixLines.push(line);
			else break;
			cntLines++;
		}
		return cntLines;
	}

	static _mutAbilityScoresFromSingleLine (stats, meta) {
		const abilities = meta.toConvert[meta.ixToConvert].trim().replace(/[-\u2012\u2013\u2014]+/g, "-").split(/ ?\(([+-])?[0-9]*\) ?/g);
		stats.str = this._tryConvertNumber(abilities[0]);
		stats.dex = this._tryConvertNumber(abilities[2]);
		stats.con = this._tryConvertNumber(abilities[4]);
		stats.int = this._tryConvertNumber(abilities[6]);
		stats.wis = this._tryConvertNumber(abilities[8]);
		stats.cha = this._tryConvertNumber(abilities[10]);
	}

	static _tryGetStat (strLine) {
		try {
			return this._tryConvertNumber(/(\d+) ?\(.*?\)/.exec(strLine)[1]);
		} catch (e) {
			return 0;
		}
	}

	// SHARED PARSING FUNCTIONS ////////////////////////////////////////////////////////////////////////////////////////
	static _setCleanSizeTypeAlignment (stats, meta, options) {
		this._setCleanSizeTypeAlignment_sidekick(stats, meta, options)
			|| this._setCleanSizeTypeAlignment_standard(stats, meta, options);

		stats.type = this._tryParseType({stats, strType: stats.type});

		this._setCleanSizeTypeAlignment_postProcess(stats, meta, options);
	}

	static _setCleanSizeTypeAlignment_sidekick (stats, meta, options) {
		const mSidekick = /^(\d+)(?:st|nd|rd|th)\s*\W+\s*level\s+(.*)$/i.exec(meta.curLine.trim());
		if (!mSidekick) return false;

		// sidekicks
		stats.level = Number(mSidekick[1]);
		stats.size = mSidekick[2].trim()[0].toUpperCase();
		stats.type = mSidekick[2].split(" ").splice(1).join(" ");
	}

	static _setCleanSizeTypeAlignment_standard (stats, meta, options) {
		const ixSwarm = / swarm /i.exec(meta.curLine)?.index;

		// regular creatures

		// region Size
		const reSize = new RegExp(`(${Object.values(Parser.SIZE_ABV_TO_FULL).join("|")})`, "i");
		const reSizeGlobal = new RegExp(reSize, "gi");

		const tks = meta.curLine.split(reSizeGlobal);
		let ixSizeLast = -1;
		for (let ixSize = 0; ixSize < tks.length; ++ixSize) {
			if (ixSwarm != null && tks.slice(0, ixSizeLast + 1).join("").length >= ixSwarm) break;

			const tk = tks[ixSize];
			if (reSize.test(tk)) {
				ixSizeLast = ixSize;
				(stats.size = stats.size || []).push(tk[0].toUpperCase());
			}
		}
		stats.size.sort(SortUtil.ascSortSize);
		// endregion

		const tksNoSize = tks.slice(ixSizeLast + 1);

		const spl = tksNoSize.join("").split(StrUtil.COMMAS_NOT_IN_PARENTHESES_REGEX);

		const ptsOtherSizeOrType = spl[0].split(" ").map(it => it.trim()).filter(Boolean);

		stats.type = ptsOtherSizeOrType.join(" ");

		stats.alignment = (spl[1] || "").toLowerCase();
		AlignmentConvert.tryConvertAlignment(stats, (ali) => options.cbWarning(`Alignment "${ali}" requires manual conversion`));
	}

	static _setCleanSizeTypeAlignment_postProcess (stats, meta, options) {
		const validTypes = new Set(Parser.MON_TYPES);
		if (!stats.type.type?.choose && (!validTypes.has(stats.type.type || stats.type))) {
			// check if the last word is a creature type
			const curType = stats.type.type || stats.type;
			let parts = curType.split(/(\W+)/g);
			parts = parts.filter(Boolean);
			if (validTypes.has(parts.last())) {
				const note = parts.slice(0, -1);
				if (stats.type.type) {
					stats.type.type = parts.last();
				} else {
					stats.type = parts.last();
				}
				stats.sizeNote = note.join("").trim();
			}
		}
	}

	static _addExtraTypeTags (stats, meta) {
		if (!meta.additionalTypeTags?.length) return;

		// Transform to complex form if simple
		if (!stats.type.type) stats.type = {type: stats.type};
		if (!stats.type.tags?.length) stats.type.tags = [];
		stats.type.tags.push(...meta.additionalTypeTags);
	}

	static _setCleanHp (stats, line) {
		const rawHp = ConvertUtil.getStatblockLineHeaderText({reStartStr: "Hit Points", line});
		// split HP into average and formula
		const m = /^(\d+)\s*\((.*?)\)$/.exec(rawHp.trim());
		if (!m) stats.hp = {special: rawHp}; // for e.g. Avatar of Death
		else if (!Renderer.dice.lang.getTree3(m[2])) stats.hp = {special: rawHp}; // for e.g. "x (see notes)"
		else {
			stats.hp = {
				average: Number(m[1]),
				formula: m[2],
			};
			DiceConvert.cleanHpDice(stats);
		}
	}

	static _setCleanSpeed (stats, line, options) {
		stats.speed = line;
		SpeedConvert.tryConvertSpeed(stats, options.cbWarning);
	}

	static _setCleanSaves (stats, line, options) {
		stats.save = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_SAVING_THROWS, line});

		if (!stats.save?.trim()) return;

		// convert to object format
		const spl = stats.save.split(",").map(it => it.trim().toLowerCase()).filter(it => it);
		const out = {};
		spl.forEach(it => {
			const m = /^(?<abil>\w+)\s*(?<sign>[-+])\s*(?<save>\d+)(?<plusPb>(?:\s+plus\s+|\s*\+\s*)PB)?$/i.exec(it);
			if (m) {
				out[m.groups.abil.slice(0, 3)] = `${m.groups.sign}${m.groups.save}${m.groups.plusPb ? m.groups.plusPb.replace(/\bpb\b/gi, "PB") : ""}`;
				return;
			}

			if (/^\+PB to all$/i.test(it)) {
				Parser.ABIL_ABVS.forEach(ab => out[ab] = "+PB");
				return;
			}

			options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Save "${it}" requires manual conversion`);
		});
		stats.save = out;
	}

	static _setCleanSkills (stats, line, options) {
		stats.skill = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_SKILLS, line}).toLowerCase();
		const split = stats.skill.split(",").map(it => it.trim()).filter(Boolean);

		const reSkill = new RegExp(`^(?<skill>${Object.keys(Parser.SKILL_TO_ATB_ABV).join("|")})\\s+(?<val>.*)$`, "i");

		const newSkills = {};
		try {
			split.forEach(s => {
				const m = reSkill.exec(s);
				if (!m) {
					options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Skill "${s}" requires manual conversion`);
					return;
				}
				newSkills[m.groups.skill] = m.groups.val.replace(/\b\+?pb\b/g, "PB");
			});
			stats.skill = newSkills;
			if (stats.skill[""]) delete stats.skill[""]; // remove empty properties
		} catch (ignored) {
			setTimeout(() => { throw ignored; });
		}
	}

	static _setCleanDamageVuln (stats, line, options) {
		stats.vulnerable = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_DAMAGE_VULN, line});
		stats.vulnerable = CreatureDamageVulnerabilityConverter.getParsed(stats.vulnerable, options);
		if (stats.vulnerable == null) delete stats.vulnerable;
	}

	static _setCleanDamageRes (stats, line, options) {
		stats.resist = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_DAMAGE_RES, line});
		stats.resist = CreatureDamageResistanceConverter.getParsed(stats.resist, options);
		if (stats.resist == null) delete stats.resist;
	}

	static _setCleanDamageImm (stats, line, options) {
		stats.immune = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_DAMAGE_IMM, line});
		stats.immune = CreatureDamageImmunityConverter.getParsed(stats.immune, options);
		if (stats.immune == null) delete stats.immune;
	}

	static _setCleanConditionImm (stats, line, options) {
		stats.conditionImmune = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_CONDITION_IMM, line});
		stats.conditionImmune = CreatureConditionImmunityConverter.getParsed(stats.conditionImmune, options);
		if (stats.conditionImmune == null) delete stats.conditionImmune;
	}

	static _setCleanSenses ({stats, line, cbWarning}) {
		const senses = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_SENSES, line});
		const tempSenses = [];

		senses
			.split(StrUtil.COMMA_SPACE_NOT_IN_PARENTHESES_REGEX)
			.forEach(pt => {
				pt = pt.trim();
				if (!pt) return;

				if (!pt.toLowerCase().includes("passive perception")) return tempSenses.push(pt.toLowerCase());

				let ptPassive = pt.split(/passive perception/i)[1].trim();
				if (!isNaN(ptPassive)) return stats.passive = this._tryConvertNumber(ptPassive);

				if (
					!/^\d+\s+(?:plus|\+)\s+PB$/i.test(ptPassive)
					&& !/^\d+\s+(?:plus|\+)\s+\(PB\s*(?:×|\*|x|times)\s*\d+\)$/i.test(ptPassive)
				) return cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Passive perception "${ptPassive}" requires manual conversion`);

				// Handle e.g. "10 plus PB"
				stats.passive = ptPassive;
			});

		if (tempSenses.length) stats.senses = tempSenses;
		else delete stats.senses;
	}

	static _setCleanLanguages (stats, line) {
		stats.languages = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_LANGUAGES, line});
		if (stats.languages && /^([-–‒—]|\\u201\d)+$/.exec(stats.languages.trim())) delete stats.languages;
		else {
			stats.languages = stats.languages
				// Clean caps words
				.split(/(\W)/g)
				.map(s => {
					return s
						.replace(/Telepathy/g, "telepathy")
						.replace(/All/g, "all")
						.replace(/Understands/g, "understands")
						.replace(/Cant/g, "cant")
						.replace(/Can/g, "can");
				})
				.join("")
				.split(StrUtil.COMMA_SPACE_NOT_IN_PARENTHESES_REGEX);
		}
	}

	static _setCleanCr (stats, meta, {cbWarning, header = "Challenge"} = {}) {
		let line = ConvertUtil.getStatblockLineHeaderText({reStartStr: header, line: meta.curLine});
		let xp = null;

		line = line
			.replace(/\((?<amount>[0-9,]+)\s*XP\)/i, (...m) => {
				const amountRaw = m.last().amount.replace(/,/, "");
				if (isNaN(amountRaw)) return m[0];

				xp = Number(amountRaw);

				return "";
			})
			.trim();

		if (!line) return;
		if (/^[-\u2012-\u2014]$/.test(line)) return;

		const reTags = new RegExp(`\\b(?<tag>${Object.keys(this._BREW_CR_LINE_TAGS).map(it => it.escapeRegexp()).join("|")})\\b`, "gi");
		line = line
			.replace(reTags, (...m) => {
				meta.addAdditionalTypeTag(this._BREW_CR_LINE_TAGS[m.last().tag.toLowerCase()]);
				return "";
			})
			.trim();

		if (!line) return;

		if (/^[⅛¼½]$/.test(line)) {
			line = Parser.numberToCr(Parser.vulgarToNumber(line));
		}

		if (!/^(\d+\/\d+|\d+)$/.test(line)) {
			cbWarning(`${stats.name ? `(${stats.name}) ` : ""}CR requires manual conversion "${line}"`);
			return;
		}

		const cr = line;

		if (xp != null && Parser.crToXpNumber(cr) !== xp) {
			stats.cr = {
				cr,
				xp,
			};
			return;
		}

		stats.cr = cr;
	}

	static _BREW_CR_LINE_TAGS = {
		// region MCDM
		"ambusher": "Ambusher",
		"artillery": "Artillery",
		"brute": "Brute",
		"companion": "Companion",
		"controller": "Controller",
		"leader": "Leader",
		"minion": "Minion",
		"retainer": "Retainer",
		"skirmisher": "Skirmisher",
		"soldier": "Soldier",
		"solo": "Solo",
		"support": "Support",
		// endregion
	};

	static _setCleanPbNote (stats, line) {
		stats.pbNote = ConvertUtil.getStatblockLineHeaderText({reStartStr: this._RE_START_PROF_BONUS, line});

		if (stats.pbNote && !isNaN(stats.pbNote) && Parser.crToPb(stats.cr) === Number(stats.pbNote)) delete stats.pbNote;
	}

	// region SHARED HOMEBREW PARSING FUNCTIONS /////////////////////////////////////////////////////////////////////////
	static _RE_BREW_RESOURCE_SOULS = /^Souls (?<value>\d+) \((?<formula>[^)]+)\)$/;

	static _brew_setResourceSouls (stats, meta, options) {
		const m = this._RE_BREW_RESOURCE_SOULS.exec(meta.curLine);
		(stats.resource = stats.resource || [])
			.push({
				name: "Souls",
				value: Number(m.groups.value),
				formula: m.groups.formula,
			});
	}
	// endregion
}
CreatureParser._PROPS_ENTRIES = [
	"trait",
	"action",
	"bonus",
	"reaction",
	"legendary",
	"mythic",
];

globalThis.CreatureParser = CreatureParser;
