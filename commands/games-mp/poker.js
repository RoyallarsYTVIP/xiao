const Command = require('../../structures/Command');
const Collection = require('@discordjs/collection');
const { Hand } = require('pokersolver');
const { stripIndents } = require('common-tags');
const Deck = require('../../structures/cards/Deck');
const { formatNumber, list, delay } = require('../../util/Util');
const { SUCCESS_EMOJI_ID } = process.env;
const max = 6;
const min = 2;
const bigBlindAmount = 100;
const smallBlindAmount = 50;
const raiseRegex = /raise (\$?([0-9]+)?,?[0-9]+)/i;

module.exports = class PokerCommand extends Command {
	constructor(client) {
		super(client, {
			name: 'poker',
			aliases: ['texas-hold-em'],
			group: 'games-mp',
			memberName: 'poker',
			description: `Play poker with up to ${max - 1} other users.`,
			guildOnly: true,
			args: [
				{
					key: 'playersCount',
					prompt: 'How many players are you expecting to have?',
					type: 'integer',
					min,
					max
				}
			]
		});
	}

	async run(msg, { playersCount }) {
		const current = this.client.games.get(msg.channel.id);
		if (current) return msg.reply(`Please wait until the current game of \`${current.name}\` is finished.`);
		await msg.say(`**The \`${this.name}\` command is currently in beta. Do not expect it to work properly.**`);
		this.client.games.set(msg.channel.id, {
			name: this.name,
			data: {
				deck: new Deck(),
				players: new Collection(),
				turnData: {
					pot: 0,
					currentBet: 0,
					highestBetter: null
				}
			}
		});
		try {
			const awaitedPlayers = await this.awaitPlayers(msg, playersCount);
			if (!awaitedPlayers) {
				this.client.games.delete(msg.channel.id);
				return msg.say('Game could not be started...');
			}
			const { players, deck, turnData } = this.client.games.get(msg.channel.id).data;
			for (const player of awaitedPlayers) {
				players.set(player, {
					money: 5000,
					id: player,
					hand: [],
					user: this.client.users.cache.get(player),
					currentBet: 0,
					hasGoneOnce: false
				});
			}
			let winner = null;
			const rotation = players.map(p => p.id);
			while (!winner) {
				const bigBlind = players.get(rotation[1]);
				bigBlind.money -= bigBlindAmount;
				bigBlind.currentBet += bigBlindAmount;
				const smallBlind = players.get(rotation[2] || rotation[0]);
				smallBlind.money -= smallBlindAmount;
				smallBlind.currentBet += smallBlindAmount;
				rotation.push(rotation[0]);
				rotation.shift();
				const folded = [];
				await msg.say('Dealing player hands...');
				for (const player of players.values()) {
					player.hand.push(...deck.draw(2));
					try {
						await player.user.send(stripIndents`
							**Your Poker Hand:**
							${player.hand.map(c => c.textDisplay).join('\n')}

							**Money:** $${formatNumber(player.money)}
							${bigBlind.id === player.id ? '_You are the big blind._' : ''}
							${smallBlind.id === player.id ? '_You are the small blind._' : ''}
						`);
					} catch {
						await msg.say(`${player.user}, I couldn't send your hand! Turn on DMs!`);
					}
				}
				turnData.pot = bigBlindAmount + smallBlindAmount;
				turnData.currentBet = bigBlindAmount;
				turnData.highestBetter = bigBlind;
				let keepGoing = await this.gameRound(msg, players, folded, turnData, bigBlind, smallBlind);
				if (!keepGoing) continue;
				const dealerHand = deck.draw(3);
				await msg.say(stripIndents`
					**Dealer Hand:**
					${dealerHand.map(card => card.textDisplay).join('\n')}

					_Next betting round begins in 5 seconds._
				`);
				await delay(5000);
				keepGoing = await this.gameRound(msg, players, folded, turnData, bigBlind, smallBlind);
				if (!keepGoing) continue;
				dealerHand.push(deck.draw());
				await msg.say(stripIndents`
					**Dealer Hand:**
					${dealerHand.map(card => card.textDisplay).join('\n')}

					_Next betting round begins in 5 seconds._
				`);
				await delay(5000);
				keepGoing = await this.gameRound(msg, players, folded, turnData, bigBlind, smallBlind);
				if (!keepGoing) continue;
				dealerHand.push(deck.draw());
				await msg.say(stripIndents`
					**Dealer Hand:**
					${dealerHand.map(card => card.textDisplay).join('\n')}

					_Next betting round begins in 5 seconds._
				`);
				await delay(5000);
				keepGoing = await this.gameRound(msg, players, folded, turnData, bigBlind, smallBlind);
				if (!keepGoing) continue;
				const solved = [];
				for (const playerID of rotation) {
					if (folded.includes(playerID)) continue;
					const player = players.get(playerID);
					const solvedHand = Hand.solve([
						...player.hand.map(card => card.pokersolverKey),
						...dealerHand.map(card => card.pokersolverKey)
					]);
					solvedHand.user = player;
					solved.push(solvedHand);
				}
				const winners = Hand.winners(solved);
				if (winners.length > 1) {
					await msg.say(stripIndents`
						The pot will be split between ${list(winners.map(w => `**${w.user.user}**`))}.
						${winners.map(winner.descr).join(', ')}

						__**Results**__
						${solved.map(solve => `${solve.user.user.tag}: ${solve.descr}`).join('\n')}

						_Next game starting in 10 seconds._
					`);
					const splitPot = turnData.pot / winners.length;
					for (const win of winners) win.user.money += splitPot;
				} else {
					await msg.say(stripIndents`
						${winners[0].user.user} takes the pot, with **${winners[0].descr}**.

						__**Results**__
						${solved.map(solve => `${solve.user.user.tag}: ${solve.descr}`).join('\n')}

						_Next game starting in 10 seconds._
					`);
					winners[0].user.money += turnData.pot;
				}
				await this.resetGame(msg, players);
				if (players.size <= 1) {
					winner = players.first();
					break;
				}
				await delay(10000);
			}
			this.client.games.delete(msg.channel.id);
			return msg.say(`Congrats, ${winner.user}!`);
		} catch (err) {
			this.client.games.delete(msg.channel.id);
			throw err;
		}
	}

	async awaitPlayers(msg, players) {
		await msg.say(`You will need at least 1 more player (at max ${players - 1}). To join, type \`join game\`.`);
		const joined = [];
		joined.push(msg.author.id);
		const filter = res => {
			if (res.author.bot) return false;
			if (joined.includes(res.author.id)) return false;
			if (res.content.toLowerCase() !== 'join game') return false;
			joined.push(res.author.id);
			res.react(SUCCESS_EMOJI_ID || '✅').catch(() => null);
			return true;
		};
		const verify = await msg.channel.awaitMessages(filter, { max: players - 1, time: 30000 });
		verify.set(msg.id, msg);
		if (verify.size < min) return false;
		return verify.map(player => player.author.id);
	}

	determineActions(turnPlayer, currentBet) {
		const actions = [];
		if (turnPlayer.currentBet !== currentBet) actions.push('fold');
		if (turnPlayer.money > currentBet) actions.push('raise <amount>');
		if (turnPlayer.money >= currentBet && turnPlayer.currentBet !== currentBet) actions.push('call');
		if (currentBet === turnPlayer.currentBet) actions.push('check');
		return actions;
	}

	makeTurnRotation(players, folded, bigBlind, smallBlind) {
		return [
			smallBlind.id,
			...players.filter(p => bigBlind.id !== p.id && smallBlind.id !== p.id).map(p => p.id),
			bigBlind.id
		].filter(player => !folded.includes(player));
	}

	async gameRound(msg, players, folded, turnData, bigBlind, smallBlind) {
		let turnOver = false;
		const turnRotation = this.makeTurnRotation(players, folded, bigBlind, smallBlind);
		while (!turnOver) turnOver = await this.bettingRound(msg, players, turnRotation, folded, turnData);
		this.resetHasGoneOnce(players);
		if (turnRotation.length === 1) {
			const remainer = players.get(turnRotation[0]);
			await msg.say(stripIndents`
				${remainer.user} takes the pot.

				_Next game starting in 10 seconds._
			`);
			remainer.money += turnData.pot;
			await this.resetGame(msg, players);
			await delay(10000);
			return false;
		}
		return true;
	}

	async bettingRound(msg, players, turnRotation, folded, data) {
		const oldHighestBetter = data.highestBetter;
		const turnPlayer = players.get(turnRotation[0]);
		const actions = this.determineActions(turnPlayer, data.currentBet);
		const displayActions = list(actions.map(action => `\`${action}\``), 'or');
		await msg.say(stripIndents`
			**Pot: $${formatNumber(data.pot)}**
			_Highest Bet: $${formatNumber(data.currentBet)} (${data.highestBetter.user.tag})_

			${turnPlayer.user}, what do you want to do? You can ${displayActions}.
		`);
		const filter = res => {
			if (res.author.id !== turnPlayer.id) return false;
			let choice = res.content.toLowerCase();
			if (actions.includes(choice) && !choice.startsWith('raise')) return true;
			if (choice.startsWith('raise')) {
				if (!raiseRegex.test(choice)) return false;
				choice = choice.replace(/[$,]/g, '');
				const amount = Number.parseInt(choice.match(raiseRegex)[1], 10);
				if (amount + data.currentBet > turnPlayer.money || amount < 1) {
					const maxBet = turnPlayer.money - data.currentBet;
					res.reply(`You can only bet up to $${formatNumber(maxBet)}!`).catch(() => null);
					return false;
				}
				return true;
			}
			return false;
		};
		const msgs = await msg.channel.awaitMessages(filter, { max: 1, time: 60000 });
		let choiceAction;
		if (msgs.size) {
			choiceAction = msgs.first().content.toLowerCase().replace(/[$,]/g, '');
		} else if (turnPlayer.currentBet !== data.currentBet) {
			choiceAction = 'fold';
		} else if (data.currentBet === turnPlayer.currentBet) {
			choiceAction = 'check';
		} else {
			choiceAction = 'fold';
		}
		const raiseValue = raiseRegex.test(choiceAction) ? Number.parseInt(choiceAction.match(raiseRegex)[1], 10) : null;
		if (raiseValue) {
			const amountChange = raiseValue + (data.currentBet - turnPlayer.currentBet);
			data.pot += amountChange;
			data.highestBetter = turnPlayer;
			turnPlayer.money -= amountChange;
			turnPlayer.currentBet += amountChange;
			data.currentBet += raiseValue;
			await msg.say(`${turnPlayer.user} **raises $${formatNumber(raiseValue)}**.`);
		} else if (choiceAction === 'call') {
			const amountChange = data.currentBet - turnPlayer.currentBet;
			turnPlayer.money -= amountChange;
			turnPlayer.currentBet += amountChange;
			data.pot += amountChange;
			await msg.say(`${turnPlayer.user} **calls $${formatNumber(data.currentBet)}**.`);
		} else if (choiceAction === 'fold') {
			folded.push(turnPlayer.id);
			await msg.say(`${turnPlayer.user} **folds**.`);
		} else if (choiceAction === 'check') {
			await msg.say(`${turnPlayer.user} **checks**.`);
		}
		if (choiceAction !== 'fold') turnRotation.push(turnRotation[0]);
		turnRotation.shift();
		turnPlayer.hasGoneOnce = true;
		const nextPlayer = players.get(turnRotation[0]);
		return (oldHighestBetter.id === turnPlayer.id && choiceAction === 'check' && nextPlayer.hasGoneOnce)
			|| (oldHighestBetter.currentBet === turnPlayer.currentBet
				&& turnRotation[0] === oldHighestBetter.id
				&& nextPlayer.hasGoneOnce)
			|| turnRotation.length === 1;
	}

	async resetGame(msg, players) {
		for (const player of players.values()) {
			if (player.money <= 0) {
				await msg.say(`${player.user} has been kicked.`);
				players.delete(player.id);
			} else {
				player.currentBet = 0;
				player.hand = [];
				player.hasGoneOnce = false;
			}
		}
		return players;
	}

	resetHasGoneOnce(players) {
		for (const player of players.values()) player.hasGoneOnce = false;
		return players;
	}
};
