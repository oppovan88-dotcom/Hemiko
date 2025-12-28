const { SimpleEmbed, cooldown, sym, getUser } = require('../../functioon/function');

const cooldowns = new Map();
let CDT = 25_000;
var getId = [];
var cdId = [];
var prem = [];

module.exports = {
    name: 'ping',
    async execute(client, message, args) {
        try{
            const user = message.author;

            const userData = await getUser(user.id);

            if(userData.premium.premium_bool){
                if(!prem.includes(user.id)){
                    prem.push(user.id);
                }
            }

            if(cooldown(user.id, getId, cdId, CDT, message, cooldowns, prem)){
                return;
            };

            let ms = parseInt(Date.now() - message.createdTimestamp);
            
            message.channel.send({ embeds: [SimpleEmbed(`🏓 Pong! to ${user.displayName} in **${ms}**ms.`, message)] });
        }catch(error){
            console.log(`ping error ${error}`);
        }
    },
};