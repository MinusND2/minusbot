const http = require('http');
const express = require('express');
const router = require('./routes');

const app = express();
app.use(express.json());
app.use('/api/car-analyzer', router);

const server = app.listen(0, async () => {
  const port = server.address().port;
  console.log(`Test Express server running on port ${port}`);

  try {
    // 1. Test GET /config
    console.log('Testing GET /api/car-analyzer/config...');
    const configRes = await fetch(`http://localhost:${port}/api/car-analyzer/config`);
    const configData = await configRes.json();
    console.log('Config success:', configData.success);
    if (!configData.success || !configData.defaultWeights) {
      throw new Error('Config failed');
    }

    // 2. Test POST /extract
    console.log('Testing POST /api/car-analyzer/extract (manual)...');
    const extractRes = await fetch(`http://localhost:${port}/api/car-analyzer/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manualData: {
          title: 'BMW 320i M Sport',
          make: 'BMW',
          model: '320i',
          year: 2020,
          price: 22490,
          mileage: 72000,
          powerHp: 184,
          fuelType: 'Benzin',
          transmission: 'Automatik'
        }
      })
    });
    const extractData = await extractRes.json();
    console.log('Extract success:', extractData.success, extractData.vehicle?.title);
    if (!extractData.success || !extractData.vehicle) {
      throw new Error('Extract failed');
    }

    // 3. Test POST /analyze
    console.log('Testing POST /api/car-analyzer/analyze...');
    const analyzeRes = await fetch(`http://localhost:${port}/api/car-analyzer/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicles: [extractData.vehicle],
        options: { annualKm: 15000 }
      })
    });
    const analyzeData = await analyzeRes.json();
    console.log('Analyze success:', analyzeData.success, 'Ranked count:', analyzeData.ranking?.length);
    console.log('Winner:', analyzeData.ranking[0].title, 'Score:', analyzeData.ranking[0].scores.overall);
    if (!analyzeData.success || analyzeData.ranking.length !== 1) {
      throw new Error('Analyze failed');
    }

    // 4. Test POST /compare
    console.log('Testing POST /api/car-analyzer/compare...');
    const car2Res = await fetch(`http://localhost:${port}/api/car-analyzer/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        manualData: {
          title: 'BMW 320i Advantage',
          make: 'BMW',
          model: '320i',
          year: 2019,
          price: 19900,
          mileage: 95000,
          powerHp: 184,
          fuelType: 'Benzin'
        }
      })
    });
    const car2Data = await car2Res.json();

    const compareRes = await fetch(`http://localhost:${port}/api/car-analyzer/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicleA: extractData.vehicle,
        vehicleB: car2Data.vehicle,
        options: { annualKm: 15000 }
      })
    });
    const compareData = await compareRes.json();
    console.log('Compare success:', compareData.success, 'Verdict:', compareData.comparison?.verdict?.title);
    if (!compareData.success || !compareData.comparison || !compareData.comparison.verdict) {
      throw new Error('Compare route failed');
    }

    console.log('🎉 ALL ROUTE TESTS PASSED SUCCESSFULLY!');
    server.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Route test failed:', err);
    server.close();
    process.exit(1);
  }
});
