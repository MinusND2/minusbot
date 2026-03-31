const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const termsPath = path.join(__dirname, 'bingo.json');

// Load initial terms
let bingoTerms = [];
try {
    const data = fs.readFileSync(termsPath, 'utf8');
    bingoTerms = JSON.parse(data);
} catch (err) {
    console.error("Error reading bingo.json:", err);
    // Fallback if file missing
    bingoTerms = new Array(25).fill("???");
}

// Auth Middleware
const auth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Authentication required');
    }
    const auth = new Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];
    
    // CHANGE PASSWORD HERE
    if (user === 'admin' && pass === 'bingo') { 
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Access denied');
    }
};

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

    // Admin route with protection
    app.get('/admin', auth, (req, res) => {
        res.sendFile(path.join(__dirname, 'protected', 'admin.html'));
    });

    app.get('/admin/scoreboard', auth, (req, res) => {
        res.sendFile(path.join(__dirname, 'protected', 'scoreboard-admin.html'));
    });

    // Game state
    let gameState = new Array(25).fill(false);
    let score = { home: 0, away: 0 };
    let teams = {
        home: { name: "BARCELONA", logo: "https://upload.wikimedia.org/wikipedia/en/thumb/4/47/FC_Barcelona_%28crest%29.svg/1200px-FC_Barcelona_%28crest%29.svg.png" },
        away: { name: "ATLETICO MADRID", logo: "https://logos-world.net/wp-content/uploads/2020/11/Atletico-Madrid-Logo.png" }
    };

    io.on('connection', (socket) => {
        console.log('A user connected');

        // Send current state and terms to new user
        socket.emit('init', { state: gameState, terms: bingoTerms, score: score, teams: teams });

        // Handle toggle event (Bingo)
        socket.on('toggle', (index) => {
            if (index >= 0 && index < 25) {
                gameState[index] = !gameState[index];
                io.emit('update', gameState);
            }
        });

        // Handle Score Update
        socket.on('updateScore', (newScore) => {
            score = newScore;
            io.emit('updateScore', score);
        });

        // Handle Teams Update
        socket.on('updateTeams', (newTeams) => {
            teams = newTeams;
            io.emit('updateTeams', teams);
        });

        // Handle reset event (Bingo)
        socket.on('reset', () => {
            gameState = new Array(25).fill(false);
            io.emit('update', gameState);
        });

    // Handle terms update
    socket.on('updateTerms', (newTerms) => {
        if (Array.isArray(newTerms) && newTerms.length === 25) {
            bingoTerms = newTerms;
            // Save to file
            fs.writeFile(termsPath, JSON.stringify(bingoTerms, null, 4), (err) => {
                if (err) console.error("Error saving bingo.json:", err);
            });
            // Notify all clients about new terms
            io.emit('termsUpdated', bingoTerms);
            // Reset game state when terms change? Maybe keep it? Usually reset makes sense if terms change completely.
            // Let's keep state for now unless user manually resets.
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Overlay Link: http://localhost:${PORT}/`);
    console.log(`Admin Link: http://localhost:${PORT}/admin (User: admin, Pass: bingo)`);
});
