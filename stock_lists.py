STOCKS = {
    'Technology': [
        ('AAPL', 'Apple Inc.'), ('MSFT', 'Microsoft'), ('NVDA', 'NVIDIA'),
        ('GOOGL', 'Alphabet'), ('META', 'Meta Platforms'), ('AMZN', 'Amazon'),
        ('TSLA', 'Tesla'), ('AMD', 'AMD'), ('AVGO', 'Broadcom'),
        ('CRM', 'Salesforce'), ('ORCL', 'Oracle'), ('ADBE', 'Adobe'),
        ('NFLX', 'Netflix'), ('QCOM', 'Qualcomm'), ('TXN', 'Texas Instruments'),
        ('MU', 'Micron'), ('AMAT', 'Applied Materials'), ('NOW', 'ServiceNow'),
        ('SNOW', 'Snowflake'), ('PLTR', 'Palantir'), ('ARM', 'ARM Holdings'),
        ('LRCX', 'Lam Research'), ('KLAC', 'KLA Corp'), ('MRVL', 'Marvell Tech'),
        ('PANW', 'Palo Alto Networks'), ('CRWD', 'CrowdStrike'),
    ],
    'Finance': [
        ('JPM', 'JPMorgan Chase'), ('BAC', 'Bank of America'), ('WFC', 'Wells Fargo'),
        ('GS', 'Goldman Sachs'), ('MS', 'Morgan Stanley'), ('V', 'Visa'),
        ('MA', 'Mastercard'), ('AXP', 'American Express'), ('BLK', 'BlackRock'),
        ('C', 'Citigroup'), ('SCHW', 'Charles Schwab'), ('COF', 'Capital One'),
        ('BX', 'Blackstone'), ('USB', 'US Bancorp'), ('PGR', 'Progressive'),
    ],
    'Healthcare': [
        ('JNJ', 'J&J'), ('UNH', 'UnitedHealth'), ('PFE', 'Pfizer'),
        ('MRK', 'Merck'), ('ABBV', 'AbbVie'), ('TMO', 'Thermo Fisher'),
        ('ABT', 'Abbott'), ('DHR', 'Danaher'), ('LLY', 'Eli Lilly'),
        ('AMGN', 'Amgen'), ('GILD', 'Gilead'), ('ISRG', 'Intuitive Surgical'),
        ('REGN', 'Regeneron'), ('VRTX', 'Vertex Pharma'), ('BMY', 'BMS'),
    ],
    'Energy': [
        ('XOM', 'Exxon Mobil'), ('CVX', 'Chevron'), ('COP', 'ConocoPhillips'),
        ('EOG', 'EOG Resources'), ('SLB', 'SLB'), ('PSX', 'Phillips 66'),
        ('VLO', 'Valero'), ('MPC', 'Marathon Pete'), ('OXY', 'Occidental'),
        ('HAL', 'Halliburton'), ('DVN', 'Devon Energy'),
    ],
    'Consumer': [
        ('WMT', 'Walmart'), ('HD', 'Home Depot'), ('MCD', "McDonald's"),
        ('NKE', 'Nike'), ('SBUX', 'Starbucks'), ('TGT', 'Target'),
        ('COST', 'Costco'), ('LOW', "Lowe's"), ('TJX', 'TJX'),
        ('DG', 'Dollar General'), ('F', 'Ford'), ('GM', 'General Motors'),
        ('RIVN', 'Rivian'), ('CMG', 'Chipotle'),
    ],
    'Industrial': [
        ('BA', 'Boeing'), ('CAT', 'Caterpillar'), ('HON', 'Honeywell'),
        ('GE', 'GE Aerospace'), ('MMM', '3M'), ('UNP', 'Union Pacific'),
        ('UPS', 'UPS'), ('LMT', 'Lockheed Martin'), ('RTX', 'RTX'),
        ('DE', 'Deere'), ('FDX', 'FedEx'), ('NOC', 'Northrop'),
    ],
    'Communication': [
        ('T', 'AT&T'), ('VZ', 'Verizon'), ('CMCSA', 'Comcast'),
        ('DIS', 'Disney'), ('CHTR', 'Charter'), ('TMUS', 'T-Mobile'),
        ('WBD', 'Warner Bros.'),
    ],
    'Materials': [
        ('LIN', 'Linde'), ('APD', 'Air Products'), ('ECL', 'Ecolab'),
        ('NEM', 'Newmont'), ('FCX', 'Freeport-McMoRan'), ('ALB', 'Albemarle'),
    ],
}

ALL_STOCKS = {}
for sector, stocks in STOCKS.items():
    for symbol, name in stocks:
        ALL_STOCKS[symbol] = {'name': name, 'sector': sector}


def get_symbols_by_sector(sector=None):
    if not sector or sector.lower() == 'all':
        return list(ALL_STOCKS.keys())
    for key in STOCKS:
        if key.lower() == sector.lower():
            return [s for s, _ in STOCKS[key]]
    return list(ALL_STOCKS.keys())


def get_stock_info(symbol):
    return ALL_STOCKS.get(symbol.upper(), {'name': symbol, 'sector': 'Unknown'})


SECTORS = ['All'] + list(STOCKS.keys())
