const http = require('http');
const xml2js = require('xml2js');
const logger = require('../main/logger');

class TallyConnector {
  constructor(options = {}) {
    this.host = options.host || 'localhost';
    this.port = options.port || 9000;
    this.timeout = options.timeout || 30000;
  }

  updateConfig(options) {
    if (options.host) this.host = options.host;
    if (options.port) this.port = options.port;
  }

  /**
   * Send XML request to Tally (single attempt)
   */
  _sendRequestOnce(xmlData) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.host,
        port: this.port,
        path: '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/xml',
          'Content-Length': Buffer.byteLength(xmlData, 'utf8')
        },
        timeout: this.timeout
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          resolve(data);
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Failed to connect to Tally: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Tally request timeout'));
      });

      req.write(xmlData);
      req.end();
    });
  }

  /**
   * Send XML request to Tally with retry and exponential backoff
   */
  async sendRequest(xmlData, maxRetries = 2) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._sendRequestOnce(xmlData);
      } catch (error) {
        lastError = error;
        const isRetryable = error.message.includes('timeout') ||
                            error.message.includes('ECONNRESET') ||
                            error.message.includes('ECONNREFUSED');

        if (attempt < maxRetries && isRetryable) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s
          logger.warn(`Tally request failed (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error('Tally request error:', error.message);
        }
      }
    }

    throw lastError;
  }

  /**
   * Check if Tally is running and get company info
   */
  async checkConnection() {
    // TDL-based request that works with Tally Prime
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>ListOfCompanies</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="ListOfCompanies">
            <TYPE>Company</TYPE>
            <FETCH>NAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);

      if (!response) {
        return { connected: false, error: 'No response from Tally' };
      }

      // Check for STATUS=1 (success)
      if (response.includes('<STATUS>1</STATUS>')) {
        // Extract company name from: <COMPANY NAME="CompanyName">
        let companyName = 'Tally Connected';
        const match = response.match(/<COMPANY[^>]*NAME="([^"]+)"/i);
        if (match) {
          companyName = this.decodeXmlEntities(match[1]);
        }

        return {
          connected: true,
          companyName: companyName,
          tallyVersion: 'Tally Prime'
        };
      }

      // Check for error
      const errorMatch = response.match(/<LINEERROR>([^<]+)<\/LINEERROR>/i);
      if (errorMatch) {
        return { connected: false, error: this.decodeXmlEntities(errorMatch[1]) };
      }

      return { connected: false, error: 'Invalid response from Tally' };
    } catch (error) {
      return { connected: false, error: error.message };
    }
  }

  /**
   * Get all ledgers from Tally
   */
  async getLedgers(group = null) {
    // Use TDL-based collection request (works without file export)
    let xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllLedgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllLedgers">
            <TYPE>Ledger</TYPE>
            <FETCH>NAME, PARENT</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      logger.info('Tally getLedgers response length:', response ? response.length : 0);

      const ledgers = await this.parseLedgersResponse(response);
      logger.info(`Parsed ${ledgers.length} ledgers from Tally`);
      return ledgers;
    } catch (error) {
      logger.error('Failed to get ledgers:', error);
      throw error;
    }
  }

  /**
   * Parse ledgers from Tally response using xml2js
   */
  async parseLedgersResponse(xmlResponse) {
    const ledgers = [];

    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      // Navigate to ledger collection - handle various Tally response structures
      let ledgerList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body.IMPORTDATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          ledgerList = coll.LEDGER || [];
        } else if (collection.LEDGER) {
          ledgerList = collection.LEDGER || [];
        }
      }

      if (!Array.isArray(ledgerList)) ledgerList = [ledgerList];

      for (const ledger of ledgerList) {
        const name = (ledger.$ && ledger.$.NAME) || this.getXml2jsValue(ledger.NAME) || '';
        const group = this.getXml2jsValue(ledger.PARENT) || '';
        if (name.trim()) {
          ledgers.push({ name: name.trim(), group: group.trim() });
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed, falling back to regex:', error.message);
      // Fallback to regex for resilience
      const pattern = /<LEDGER\s+NAME="([^"]+)"[^>]*>[\s\S]*?<PARENT[^>]*>([^<]*)<\/PARENT>/gi;
      let match;
      while ((match = pattern.exec(xmlResponse)) !== null) {
        const name = this.decodeXmlEntities(match[1]).trim();
        const group = this.decodeXmlEntities(match[2]).trim();
        if (name) ledgers.push({ name, group });
      }
    }

    logger.info(`Parsed ${ledgers.length} ledgers`);
    return ledgers;
  }

  /**
   * Helper to extract text value from xml2js parsed node
   */
  getXml2jsValue(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) {
      const item = node[0];
      if (typeof item === 'string') return item;
      if (item && item._) return item._;
      if (item && typeof item === 'object') return item._ || '';
      return '';
    }
    if (node._) return node._;
    return '';
  }

  /**
   * Sync a single invoice to Tally
   */
  async syncInvoice(invoice, mapping) {
    try {
      // First, ensure party ledger exists
      await this.ensurePartyLedger(invoice.client, mapping);

      // Create sales voucher XML
      const voucherXml = this.createSalesVoucherXml(invoice, mapping);

      // Post to Tally
      const response = await this.sendRequest(voucherXml);

      // Check response for success
      const result = this.parseVoucherResponse(response);

      if (result.created > 0) {
        logger.info(`Invoice ${invoice.invoice_number} synced successfully`);
        return { success: true, voucherNumber: invoice.invoice_number };
      } else if (result.errors > 0) {
        throw new Error(`Tally error: ${result.errorMessage || 'Unknown error'}`);
      }

      return { success: true };
    } catch (error) {
      logger.error(`Failed to sync invoice ${invoice.invoice_number}:`, error);
      throw error;
    }
  }

  /**
   * Create or verify party ledger exists (uses exact name matching via TDL)
   */
  async ensurePartyLedger(client, mapping) {
    const partyName = client.name;

    // Use TDL collection with exact name filter for reliable check
    const checkXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CheckLedger</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CheckLedger">
            <TYPE>Ledger</TYPE>
            <FILTER>LedgerNameFilter</FILTER>
            <FETCH>NAME</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="LedgerNameFilter">
            $NAME = "${this.escapeXml(partyName)}"
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(checkXml);

      // Parse response to check if exact ledger was found
      const parsed = await this.parseXmlResponse(response);
      const envelope = parsed.ENVELOPE || parsed;
      let found = false;

      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          found = !!(coll.LEDGER);
        } else if (collection.LEDGER) {
          found = true;
        }
      }

      if (!found) {
        await this.createPartyLedger(client, mapping);
      }
    } catch (error) {
      // Ledger might not exist, try to create it
      logger.warn(`Could not verify ledger "${partyName}", attempting creation:`, error.message);
      await this.createPartyLedger(client, mapping);
    }
  }

  /**
   * Create a party ledger in Tally
   */
  async createPartyLedger(client, mapping) {
    const partyName = this.escapeXml(client.name);
    const parentGroup = mapping.defaultPartyGroup || 'Sundry Debtors';

    let addressParts = [];
    if (client.address) addressParts.push(client.address);
    if (client.city) addressParts.push(client.city);
    if (client.state) addressParts.push(client.state);
    if (client.pinCode) addressParts.push(client.pinCode);

    const address = this.escapeXml(addressParts.join(', '));
    const gstin = client.gstin ? this.escapeXml(client.gstin) : '';

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${partyName}" ACTION="Create">
            <NAME>${partyName}</NAME>
            <PARENT>${this.escapeXml(parentGroup)}</PARENT>
            <ISBILLWISEON>Yes</ISBILLWISEON>
            <AFFECTSSTOCK>No</AFFECTSSTOCK>
            <ISREVENUE>No</ISREVENUE>
            <ISCOSTCENTRESON>No</ISCOSTCENTRESON>
            ${address ? `<ADDRESS.LIST><ADDRESS>${address}</ADDRESS></ADDRESS.LIST>` : ''}
            ${gstin ? `<PARTYGSTIN>${gstin}</PARTYGSTIN>` : ''}
            ${client.state ? `<LEDSTATENAME>${this.escapeXml(client.state)}</LEDSTATENAME>` : ''}
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      const result = this.parseVoucherResponse(response);

      if (result.errors > 0) {
        logger.warn(`Could not create party ledger ${client.name}: ${result.errorMessage}`);
      } else {
        logger.info(`Created party ledger: ${client.name}`);
      }
    } catch (error) {
      logger.warn(`Failed to create party ledger ${client.name}:`, error.message);
    }
  }

  /**
   * Create sales voucher XML for an invoice
   */
  createSalesVoucherXml(invoice, mapping) {
    const partyName = this.escapeXml(invoice.client.name);
    const invoiceNumber = this.escapeXml(invoice.invoice_number);
    const invoiceDate = this.formatTallyDate(invoice.invoice_date);

    // Calculate GST amounts
    const { cgst, sgst, igst } = this.calculateGst(invoice, mapping);

    // Build narration
    let narration = '';
    if (invoice.notes) {
      narration = invoice.notes.replace(/\n/g, ' ').replace(/\r/g, '');
    }
    narration += ` [Invoice ${invoice.invoice_number} - Imported from NexInvo]`;
    narration = this.escapeXml(narration.trim());

    // Build ledger entries
    let ledgerEntries = '';

    // Party (Debit) - Total amount
    ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${partyName}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
          <AMOUNT>-${invoice.total_amount}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;

    // Sales (Credit) - Subtotal
    if (invoice.subtotal && parseFloat(invoice.subtotal) > 0) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.salesLedger || 'Sales')}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${invoice.subtotal}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // CGST (Credit)
    if (cgst > 0 && mapping.cgstLedger) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.cgstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${cgst.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // SGST (Credit)
    if (sgst > 0 && mapping.sgstLedger) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.sgstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${sgst.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // IGST (Credit)
    if (igst > 0 && mapping.igstLedger) {
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.igstLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
          <AMOUNT>${igst.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    // Round Off (Credit/Debit)
    if (invoice.round_off && parseFloat(invoice.round_off) !== 0 && mapping.roundOffLedger) {
      const roundOff = parseFloat(invoice.round_off);
      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${this.escapeXml(mapping.roundOffLedger)}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${roundOff < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
          <AMOUNT>${Math.abs(roundOff).toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>${invoiceDate}</DATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${invoiceNumber}</VOUCHERNUMBER>
            <REFERENCE>${invoiceNumber}</REFERENCE>
            <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
            <NARRATION>${narration}</NARRATION>
            <ISINVOICE>Yes</ISINVOICE>
            <EFFECTIVEDATE>${invoiceDate}</EFFECTIVEDATE>
            ${ledgerEntries}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    return xml;
  }

  /**
   * Calculate GST - uses actual amounts from NexInvo if available,
   * falls back to state-code based calculation
   */
  calculateGst(invoice, mapping) {
    // Use actual CGST/SGST/IGST from NexInvo if available
    const cgstFromInvoice = parseFloat(invoice.cgst_amount) || 0;
    const sgstFromInvoice = parseFloat(invoice.sgst_amount) || 0;
    const igstFromInvoice = parseFloat(invoice.igst_amount) || 0;

    if (cgstFromInvoice > 0 || sgstFromInvoice > 0 || igstFromInvoice > 0) {
      return {
        cgst: cgstFromInvoice,
        sgst: sgstFromInvoice,
        igst: igstFromInvoice
      };
    }

    // Fallback: calculate from total tax_amount using GSTIN state codes
    const taxAmount = parseFloat(invoice.tax_amount) || 0;
    if (taxAmount === 0) return { cgst: 0, sgst: 0, igst: 0 };

    const companyStateCode = mapping.companyGstin ? mapping.companyGstin.substring(0, 2) : '';
    const clientStateCode = invoice.client && invoice.client.gstin ? invoice.client.gstin.substring(0, 2) : '';

    const isInterState = companyStateCode && clientStateCode && companyStateCode !== clientStateCode;

    if (isInterState) {
      return { cgst: 0, sgst: 0, igst: taxAmount };
    } else {
      return { cgst: taxAmount / 2, sgst: taxAmount / 2, igst: 0 };
    }
  }

  /**
   * Parse voucher import response
   */
  parseVoucherResponse(xmlResponse) {
    const result = {
      created: 0,
      altered: 0,
      errors: 0,
      errorMessage: ''
    };

    // Extract counts using regex
    const createdMatch = xmlResponse.match(/<CREATED>(\d+)<\/CREATED>/i);
    const alteredMatch = xmlResponse.match(/<ALTERED>(\d+)<\/ALTERED>/i);
    const errorsMatch = xmlResponse.match(/<ERRORS>(\d+)<\/ERRORS>/i);
    const lineErrorMatch = xmlResponse.match(/<LINEERROR>([^<]*)<\/LINEERROR>/i);

    if (createdMatch) result.created = parseInt(createdMatch[1]);
    if (alteredMatch) result.altered = parseInt(alteredMatch[1]);
    if (errorsMatch) result.errors = parseInt(errorsMatch[1]);
    if (lineErrorMatch && lineErrorMatch[1]) {
      result.errorMessage = this.decodeXmlEntities(lineErrorMatch[1]);
    }

    return result;
  }

  /**
   * Check if a voucher already exists in Tally (exact match via TDL filter)
   */
  async checkVoucherExists(voucherNumber, voucherDate) {
    const formattedDate = this.formatTallyDate(voucherDate);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CheckVoucher</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>${formattedDate}</SVFROMDATE>
        <SVTODATE>${formattedDate}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CheckVoucher">
            <TYPE>Voucher</TYPE>
            <FILTER>VoucherMatchFilter</FILTER>
            <FETCH>VOUCHERNUMBER</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="VoucherMatchFilter">
            $VOUCHERTYPENAME = "Sales" AND $VOUCHERNUMBER = "${this.escapeXml(voucherNumber)}"
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      const parsed = await this.parseXmlResponse(response);
      const envelope = parsed.ENVELOPE || parsed;

      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          return !!(coll.VOUCHER);
        }
        return !!(collection.VOUCHER);
      }
      return false;
    } catch (error) {
      logger.warn('Could not check voucher existence:', error.message);
      return false;
    }
  }

  /**
   * Format date for Tally (YYYYMMDD)
   */
  formatTallyDate(dateStr) {
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  /**
   * Escape XML special characters
   */
  escapeXml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Decode XML entities
   */
  decodeXmlEntities(str) {
    if (!str) return '';
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  /**
   * Parse XML response to JSON
   */
  async parseXmlResponse(xmlString) {
    return new Promise((resolve, reject) => {
      const parser = new xml2js.Parser({
        explicitArray: true,
        ignoreAttrs: false
      });

      parser.parseString(xmlString, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Get all parties (Sundry Debtors) from Tally for import as Clients
   */
  async getParties() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllParties</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllParties">
            <TYPE>Ledger</TYPE>
            <CHILDOF>Sundry Debtors</CHILDOF>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>NAME, PARENT, ADDRESS, LEDSTATENAME, PINCODE, LEDGERPHONE, LEDGERMOBILE, EMAIL, PARTYGSTIN</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml);
      return await this.parsePartiesResponse(response);
    } catch (error) {
      logger.error("Failed to get parties:", error);
      throw error;
    }
  }

  async parsePartiesResponse(xmlResponse) {
    const parties = [];

    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let ledgerList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          ledgerList = coll.LEDGER || [];
        } else if (collection.LEDGER) {
          ledgerList = collection.LEDGER || [];
        }
      }

      if (!Array.isArray(ledgerList)) ledgerList = [ledgerList];

      for (const ledger of ledgerList) {
        const name = (ledger.$ && ledger.$.NAME) || this.getXml2jsValue(ledger.NAME) || '';
        if (name.trim()) {
          // Extract address from ADDRESS.LIST if present
          let address = '';
          if (ledger['ADDRESS.LIST']) {
            const addrList = Array.isArray(ledger['ADDRESS.LIST']) ? ledger['ADDRESS.LIST'][0] : ledger['ADDRESS.LIST'];
            address = this.getXml2jsValue(addrList.ADDRESS) || '';
          }

          parties.push({
            name: name.trim(),
            group: this.getXml2jsValue(ledger.PARENT) || '',
            address: address,
            state: this.getXml2jsValue(ledger.LEDSTATENAME) || '',
            pincode: this.getXml2jsValue(ledger.PINCODE) || '',
            phone: this.getXml2jsValue(ledger.LEDGERPHONE) || this.getXml2jsValue(ledger.LEDGERMOBILE) || '',
            email: this.getXml2jsValue(ledger.EMAIL) || '',
            gstin: this.getXml2jsValue(ledger.PARTYGSTIN) || ''
          });
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for parties, falling back to regex:', error.message);
      const pattern = /<LEDGER\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/LEDGER>/gi;
      let match;
      while ((match = pattern.exec(xmlResponse)) !== null) {
        const name = this.decodeXmlEntities(match[1]).trim();
        const content = match[2];
        if (name) {
          parties.push({
            name, group: this.extractTagValue(content, "PARENT"),
            address: this.extractTagValue(content, "ADDRESS"),
            state: this.extractTagValue(content, "LEDSTATENAME"),
            pincode: this.extractTagValue(content, "PINCODE"),
            phone: this.extractTagValue(content, "LEDGERPHONE") || this.extractTagValue(content, "LEDGERMOBILE"),
            email: this.extractTagValue(content, "EMAIL"),
            gstin: this.extractTagValue(content, "PARTYGSTIN")
          });
        }
      }
    }
    return parties;
  }

  async getStockItems() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllStockItems</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllStockItems">
            <TYPE>StockItem</TYPE>
            <FETCH>NAME, PARENT, BASEUNITS, HSNCODE, DESCRIPTION, OPENINGRATE</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml);
      return await this.parseStockItemsResponse(response);
    } catch (error) {
      logger.error("Failed to get stock items:", error);
      throw error;
    }
  }

  async parseStockItemsResponse(xmlResponse) {
    const items = [];

    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let stockList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          stockList = coll.STOCKITEM || [];
        } else if (collection.STOCKITEM) {
          stockList = collection.STOCKITEM || [];
        }
      }

      if (!Array.isArray(stockList)) stockList = [stockList];

      for (const item of stockList) {
        const name = (item.$ && item.$.NAME) || this.getXml2jsValue(item.NAME) || '';
        if (name.trim()) {
          items.push({
            name: name.trim(),
            group: this.getXml2jsValue(item.PARENT) || '',
            unit: this.getXml2jsValue(item.BASEUNITS) || '',
            hsn_code: this.getXml2jsValue(item.HSNCODE) || '',
            description: this.getXml2jsValue(item.DESCRIPTION) || '',
            rate: parseFloat(this.getXml2jsValue(item.OPENINGRATE)) || 0
          });
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for stock items, falling back to regex:', error.message);
      const pattern = /<STOCKITEM\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/STOCKITEM>/gi;
      let match;
      while ((match = pattern.exec(xmlResponse)) !== null) {
        const name = this.decodeXmlEntities(match[1]).trim();
        const content = match[2];
        if (name) {
          items.push({
            name, group: this.extractTagValue(content, "PARENT"),
            unit: this.extractTagValue(content, "BASEUNITS"),
            hsn_code: this.extractTagValue(content, "HSNCODE"),
            description: this.extractTagValue(content, "DESCRIPTION"),
            rate: parseFloat(this.extractTagValue(content, "OPENINGRATE")) || 0
          });
        }
      }
    }
    return items;
  }

  /**
   * Get service ledgers from Tally (ledgers under "Sales Accounts" group)
   * Used for service providers who don't have stock items
   */
  async getServiceLedgers() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>SalesLedgers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="SalesLedgers">
            <TYPE>Ledger</TYPE>
            <CHILDOF>Sales Accounts</CHILDOF>
            <BELONGSTO>Yes</BELONGSTO>
            <FETCH>NAME, PARENT, DESCRIPTION</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml);
      return await this.parseServiceLedgersResponse(response);
    } catch (error) {
      logger.error("Failed to get service ledgers:", error);
      throw error;
    }
  }

  async parseServiceLedgersResponse(xmlResponse) {
    const services = [];

    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let ledgerList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          ledgerList = coll.LEDGER || [];
        } else if (collection.LEDGER) {
          ledgerList = collection.LEDGER || [];
        }
      }

      if (!Array.isArray(ledgerList)) ledgerList = [ledgerList];

      for (const ledger of ledgerList) {
        const name = (ledger.$ && ledger.$.NAME) || this.getXml2jsValue(ledger.NAME) || '';
        if (name.trim()) {
          services.push({
            name: name.trim(),
            group: this.getXml2jsValue(ledger.PARENT) || 'Sales Accounts',
            description: this.getXml2jsValue(ledger.DESCRIPTION) || '',
            hsn_code: '',
            unit: '',
            rate: 0,
            _isService: true
          });
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for service ledgers, falling back to regex:', error.message);
      const pattern = /<LEDGER\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/LEDGER>/gi;
      let match;
      while ((match = pattern.exec(xmlResponse)) !== null) {
        const name = this.decodeXmlEntities(match[1]).trim();
        const content = match[2];
        if (name) {
          services.push({
            name,
            group: this.extractTagValue(content, "PARENT") || 'Sales Accounts',
            description: this.extractTagValue(content, "DESCRIPTION") || '',
            hsn_code: '',
            unit: '',
            rate: 0,
            _isService: true
          });
        }
      }
    }
    return services;
  }

  /**
   * Get company master details from Tally
   */
  async getCompanyDetails() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CompanyDetails</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CompanyDetails">
            <TYPE>Company</TYPE>
            <FETCH>NAME, BASICCOMPANYFORMALNAME, ADDRESS, STATENAME, PINCODE, PHONENUMBER, EMAIL, GSTIN, PANNUMBER, INCOMETAXNUMBER, COUNTRYNAME</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      logger.info('Tally getCompanyDetails response length:', response ? response.length : 0);
      return await this.parseCompanyDetailsResponse(response);
    } catch (error) {
      logger.error('Failed to get company details:', error);
      throw error;
    }
  }

  /**
   * Parse company details from Tally response
   */
  async parseCompanyDetailsResponse(xmlResponse) {
    const company = {
      companyName: '',
      tradingName: '',
      address: '',
      city: '',
      state: '',
      pinCode: '',
      stateCode: '',
      gstin: '',
      pan: '',
      phone: '',
      email: ''
    };

    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let companyNode = null;
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          const companies = coll.COMPANY || [];
          companyNode = Array.isArray(companies) ? companies[0] : companies;
        } else if (collection.COMPANY) {
          const companies = collection.COMPANY;
          companyNode = Array.isArray(companies) ? companies[0] : companies;
        }
      }

      if (companyNode) {
        company.companyName = (companyNode.$ && companyNode.$.NAME) || this.getXml2jsValue(companyNode.NAME) || '';
        company.tradingName = this.getXml2jsValue(companyNode.BASICCOMPANYFORMALNAME) || '';

        // Parse address - may be in ADDRESS.LIST or ADDRESS
        let fullAddress = '';
        if (companyNode['ADDRESS.LIST']) {
          const addrList = Array.isArray(companyNode['ADDRESS.LIST']) ? companyNode['ADDRESS.LIST'][0] : companyNode['ADDRESS.LIST'];
          const addrItems = addrList.ADDRESS || [];
          if (Array.isArray(addrItems)) {
            fullAddress = addrItems.map(a => typeof a === 'string' ? a : (a._ || '')).join(', ');
          } else {
            fullAddress = typeof addrItems === 'string' ? addrItems : (addrItems._ || '');
          }
        } else {
          fullAddress = this.getXml2jsValue(companyNode.ADDRESS) || '';
        }
        company.address = fullAddress.trim();

        company.state = this.getXml2jsValue(companyNode.STATENAME) || '';
        company.pinCode = this.getXml2jsValue(companyNode.PINCODE) || '';
        company.phone = this.getXml2jsValue(companyNode.PHONENUMBER) || '';
        company.email = this.getXml2jsValue(companyNode.EMAIL) || '';
        company.gstin = this.getXml2jsValue(companyNode.GSTIN) || '';
        company.pan = this.getXml2jsValue(companyNode.PANNUMBER) || this.getXml2jsValue(companyNode.INCOMETAXNUMBER) || '';

        // Derive stateCode from GSTIN (first 2 digits)
        if (company.gstin && company.gstin.length >= 2) {
          company.stateCode = company.gstin.substring(0, 2);
        }

        // Try to extract city from address (last line before state/pincode)
        if (company.address && !company.city) {
          const addressParts = company.address.split(',').map(p => p.trim()).filter(Boolean);
          if (addressParts.length > 1) {
            company.city = addressParts[addressParts.length - 1];
            company.address = addressParts.slice(0, -1).join(', ');
          }
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for company details, falling back to regex:', error.message);
      // Regex fallback
      const nameMatch = xmlResponse.match(/<COMPANY[^>]*NAME="([^"]+)"/i);
      if (nameMatch) company.companyName = this.decodeXmlEntities(nameMatch[1]);

      company.tradingName = this.extractTagValue(xmlResponse, 'BASICCOMPANYFORMALNAME');
      company.state = this.extractTagValue(xmlResponse, 'STATENAME');
      company.pinCode = this.extractTagValue(xmlResponse, 'PINCODE');
      company.phone = this.extractTagValue(xmlResponse, 'PHONENUMBER');
      company.email = this.extractTagValue(xmlResponse, 'EMAIL');
      company.gstin = this.extractTagValue(xmlResponse, 'GSTIN');
      company.pan = this.extractTagValue(xmlResponse, 'PANNUMBER') || this.extractTagValue(xmlResponse, 'INCOMETAXNUMBER');

      // Extract address
      const addrMatch = xmlResponse.match(/<ADDRESS>([^<]*)<\/ADDRESS>/i);
      if (addrMatch) company.address = this.decodeXmlEntities(addrMatch[1]);

      if (company.gstin && company.gstin.length >= 2) {
        company.stateCode = company.gstin.substring(0, 2);
      }
    }

    logger.info(`Parsed company details: ${company.companyName}`);
    return company;
  }

  extractTagValue(content, tagName) {
    const pattern = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, "i");
    const match = content.match(pattern);
    return match ? this.decodeXmlEntities(match[1]).trim() : "";
  }

  /**
   * Fetch recent voucher numbers from Tally for prefix detection
   * Returns just the voucher numbers (lightweight query)
   */
  async getRecentVoucherNumbers() {
    // Get vouchers from current financial year
    const now = new Date();
    const fyStart = now.getMonth() >= 3
      ? `${now.getFullYear()}0401`
      : `${now.getFullYear() - 1}0401`;
    const fyEnd = this.formatTallyDate(now.toISOString().split('T')[0]);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>RecentVoucherNumbers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>${fyStart}</SVFROMDATE>
        <SVTODATE>${fyEnd}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="RecentVoucherNumbers">
            <TYPE>Voucher</TYPE>
            <FILTER>SalesFilter</FILTER>
            <FETCH>VOUCHERNUMBER</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="SalesFilter">
            $VOUCHERTYPENAME = "Sales" AND NOT $$IsEmpty:$VOUCHERNUMBER
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      const parsed = await this.parseXmlResponse(response);
      const envelope = parsed.ENVELOPE || parsed;
      let voucherList = [];

      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          voucherList = coll.VOUCHER || [];
        } else if (collection.VOUCHER) {
          voucherList = collection.VOUCHER || [];
        }
      }

      if (!Array.isArray(voucherList)) voucherList = [voucherList];

      const numbers = [];
      for (const v of voucherList) {
        const num = this.getXml2jsValue(v.VOUCHERNUMBER) || '';
        if (num) numbers.push(num);
      }

      logger.info(`Fetched ${numbers.length} voucher numbers for prefix detection`);
      return numbers;
    } catch (error) {
      logger.error('Failed to fetch voucher numbers for prefix detection:', error);
      return [];
    }
  }

  /**
   * Get Sales Vouchers (Invoices) from Tally for a date range
   */
  async getSalesVouchers(startDate, endDate) {
    const formattedStartDate = this.formatTallyDate(startDate);
    const formattedEndDate = this.formatTallyDate(endDate);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>SalesVouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>${formattedStartDate}</SVFROMDATE>
        <SVTODATE>${formattedEndDate}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="SalesVouchers">
            <TYPE>Voucher</TYPE>
            <FILTER>SalesVchFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, REFERENCE, PARTYLEDGERNAME, AMOUNT, NARRATION, VOUCHERTYPENAME</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="SalesVchFilter">
            $VOUCHERTYPENAME = "Sales" AND NOT $$IsEmpty:$VOUCHERNUMBER
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      logger.info('Tally getSalesVouchers response length:', response ? response.length : 0);
      return await this.parseSalesVouchersResponse(response);
    } catch (error) {
      logger.error('Failed to get sales vouchers:', error);
      throw error;
    }
  }

  /**
   * Parse Sales Vouchers from Tally response using xml2js
   */
  async parseSalesVouchersResponse(xmlResponse) {
    const vouchers = [];

    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let voucherList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          voucherList = coll.VOUCHER || [];
        } else if (collection.VOUCHER) {
          voucherList = collection.VOUCHER || [];
        }
      }

      if (!Array.isArray(voucherList)) voucherList = [voucherList];

      for (const voucher of voucherList) {
        const voucherNumber = this.getXml2jsValue(voucher.VOUCHERNUMBER) || '';
        const voucherType = this.getXml2jsValue(voucher.VOUCHERTYPENAME) || '';

        if (voucherNumber && voucherType === 'Sales') {
          const dateStr = this.getXml2jsValue(voucher.DATE) || '';
          let invoiceDate = '';
          if (dateStr && dateStr.length === 8) {
            invoiceDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
          }

          vouchers.push({
            voucher_number: voucherNumber,
            reference: this.getXml2jsValue(voucher.REFERENCE) || voucherNumber,
            party_name: this.getXml2jsValue(voucher.PARTYLEDGERNAME) || '',
            invoice_date: invoiceDate,
            total_amount: Math.abs(parseFloat(this.getXml2jsValue(voucher.AMOUNT))) || 0,
            narration: this.getXml2jsValue(voucher.NARRATION) || '',
            voucher_type: voucherType
          });
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for vouchers, falling back to regex:', error.message);
      const pattern = /<VOUCHER[^>]*>([\s\S]*?)<\/VOUCHER>/gi;
      let match;
      while ((match = pattern.exec(xmlResponse)) !== null) {
        const content = match[1];
        const voucherNumber = this.extractTagValue(content, 'VOUCHERNUMBER');
        const voucherType = this.extractTagValue(content, 'VOUCHERTYPENAME');
        if (voucherNumber && voucherType === 'Sales') {
          const dateStr = this.extractTagValue(content, 'DATE');
          let invoiceDate = '';
          if (dateStr && dateStr.length === 8) {
            invoiceDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
          }
          vouchers.push({
            voucher_number: voucherNumber,
            reference: this.extractTagValue(content, 'REFERENCE') || voucherNumber,
            party_name: this.extractTagValue(content, 'PARTYLEDGERNAME'),
            invoice_date: invoiceDate,
            total_amount: Math.abs(parseFloat(this.extractTagValue(content, 'AMOUNT'))) || 0,
            narration: this.extractTagValue(content, 'NARRATION'),
            voucher_type: voucherType
          });
        }
      }
    }

    logger.info(`Parsed ${vouchers.length} sales vouchers from Tally`);
    return vouchers;
  }

  /**
   * Get all Account Groups (hierarchy) from Tally
   */
  async getAccountGroups() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllGroups</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllGroups">
            <TYPE>Group</TYPE>
            <FETCH>NAME, PARENT, ISREVENUE, ISDEEMEDPOSITIVE, BASICGROUPISCALCULABLE</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml);
      return await this.parseAccountGroupsResponse(response);
    } catch (error) {
      logger.error('Failed to get account groups:', error);
      throw error;
    }
  }

  async parseAccountGroupsResponse(xmlResponse) {
    const groups = [];
    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let groupList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          groupList = coll.GROUP || [];
        } else if (collection.GROUP) {
          groupList = collection.GROUP || [];
        }
      }

      if (!Array.isArray(groupList)) groupList = [groupList];

      for (const group of groupList) {
        const name = (group.$ && group.$.NAME) || this.getXml2jsValue(group.NAME) || '';
        if (name.trim()) {
          const isRevenue = this.getXml2jsValue(group.ISREVENUE) || '';
          const isDeemedPositive = this.getXml2jsValue(group.ISDEEMEDPOSITIVE) || '';
          groups.push({
            name: name.trim(),
            parent: this.getXml2jsValue(group.PARENT) || '',
            // Tally: ISDEEMEDPOSITIVE=Yes means Debit nature, No means Credit nature
            nature: isDeemedPositive.toLowerCase() === 'yes' ? 'debit' : 'credit',
            is_revenue: isRevenue.toLowerCase() === 'yes'
          });
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for groups, falling back to regex:', error.message);
      const pattern = /<GROUP\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/GROUP>/gi;
      let match;
      while ((match = pattern.exec(xmlResponse)) !== null) {
        const name = this.decodeXmlEntities(match[1]).trim();
        const content = match[2];
        if (name) {
          const isDeemedPositive = this.extractTagValue(content, 'ISDEEMEDPOSITIVE');
          groups.push({
            name,
            parent: this.extractTagValue(content, 'PARENT'),
            nature: isDeemedPositive.toLowerCase() === 'yes' ? 'debit' : 'credit',
            is_revenue: this.extractTagValue(content, 'ISREVENUE').toLowerCase() === 'yes'
          });
        }
      }
    }
    logger.info(`Parsed ${groups.length} account groups from Tally`);
    return groups;
  }

  /**
   * Get all Ledgers with Opening Balances from Tally
   */
  async getLedgersWithOpeningBalances() {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllLedgersWithBalances</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllLedgersWithBalances">
            <TYPE>Ledger</TYPE>
            <FETCH>NAME, PARENT, OPENINGBALANCE, CLOSINGBALANCE, PARTYGSTIN, EMAIL, LEDSTATENAME, LEDGERPHONE</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml);
      return await this.parseLedgersWithBalancesResponse(response);
    } catch (error) {
      logger.error('Failed to get ledgers with balances:', error);
      throw error;
    }
  }

  async parseLedgersWithBalancesResponse(xmlResponse) {
    const ledgers = [];
    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let ledgerList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          ledgerList = coll.LEDGER || [];
        } else if (collection.LEDGER) {
          ledgerList = collection.LEDGER || [];
        }
      }

      if (!Array.isArray(ledgerList)) ledgerList = [ledgerList];

      for (const ledger of ledgerList) {
        const name = (ledger.$ && ledger.$.NAME) || this.getXml2jsValue(ledger.NAME) || '';
        if (name.trim()) {
          // Tally returns opening balance as a number: negative = Credit, positive = Debit
          const obStr = this.getXml2jsValue(ledger.OPENINGBALANCE) || '0';
          const obValue = parseFloat(obStr) || 0;
          const cbStr = this.getXml2jsValue(ledger.CLOSINGBALANCE) || '0';
          const cbValue = parseFloat(cbStr) || 0;

          ledgers.push({
            name: name.trim(),
            parent: this.getXml2jsValue(ledger.PARENT) || '',
            opening_balance: Math.abs(obValue),
            opening_balance_type: obValue < 0 ? 'Cr' : 'Dr',
            closing_balance: Math.abs(cbValue),
            closing_balance_type: cbValue < 0 ? 'Cr' : 'Dr',
            gstin: this.getXml2jsValue(ledger.PARTYGSTIN) || '',
            email: this.getXml2jsValue(ledger.EMAIL) || '',
            state: this.getXml2jsValue(ledger.LEDSTATENAME) || '',
            phone: this.getXml2jsValue(ledger.LEDGERPHONE) || ''
          });
        }
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for ledgers with balances, falling back to regex:', error.message);
      const pattern = /<LEDGER\s+NAME="([^"]+)"[^>]*>([\s\S]*?)<\/LEDGER>/gi;
      let match;
      while ((match = pattern.exec(xmlResponse)) !== null) {
        const name = this.decodeXmlEntities(match[1]).trim();
        const content = match[2];
        if (name) {
          const obStr = this.extractTagValue(content, 'OPENINGBALANCE') || '0';
          const obValue = parseFloat(obStr) || 0;
          const cbStr = this.extractTagValue(content, 'CLOSINGBALANCE') || '0';
          const cbValue = parseFloat(cbStr) || 0;
          ledgers.push({
            name,
            parent: this.extractTagValue(content, 'PARENT'),
            opening_balance: Math.abs(obValue),
            opening_balance_type: obValue < 0 ? 'Cr' : 'Dr',
            closing_balance: Math.abs(cbValue),
            closing_balance_type: cbValue < 0 ? 'Cr' : 'Dr',
            gstin: this.extractTagValue(content, 'PARTYGSTIN'),
            email: this.extractTagValue(content, 'EMAIL'),
            state: this.extractTagValue(content, 'LEDSTATENAME'),
            phone: this.extractTagValue(content, 'LEDGERPHONE')
          });
        }
      }
    }
    logger.info(`Parsed ${ledgers.length} ledgers with balances from Tally`);
    return ledgers;
  }

  /**
   * Get ALL vouchers (all types) with line entries from Tally for a date range
   */
  async getAllVouchers(startDate, endDate) {
    const formattedStartDate = this.formatTallyDate(startDate);
    const formattedEndDate = this.formatTallyDate(endDate);

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>AllVouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>${formattedStartDate}</SVFROMDATE>
        <SVTODATE>${formattedEndDate}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="AllVouchers">
            <TYPE>Voucher</TYPE>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME, AMOUNT, NARRATION, REFERENCE</FETCH>
            <FETCH>ALLLEDGERENTRIES.LIST</FETCH>
          </COLLECTION>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;
    try {
      const response = await this.sendRequest(xml, 3); // More retries for large data
      logger.info('Tally getAllVouchers response length:', response ? response.length : 0);
      return await this.parseAllVouchersResponse(response);
    } catch (error) {
      logger.error('Failed to get all vouchers:', error);
      throw error;
    }
  }

  async parseAllVouchersResponse(xmlResponse) {
    const vouchers = [];

    try {
      const parsed = await this.parseXmlResponse(xmlResponse);
      const envelope = parsed.ENVELOPE || parsed;

      let voucherList = [];
      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          voucherList = coll.VOUCHER || [];
        } else if (collection.VOUCHER) {
          voucherList = collection.VOUCHER || [];
        }
      }

      if (!Array.isArray(voucherList)) voucherList = [voucherList];

      for (const voucher of voucherList) {
        const voucherNumber = this.getXml2jsValue(voucher.VOUCHERNUMBER) || '';
        const voucherType = this.getXml2jsValue(voucher.VOUCHERTYPENAME) || '';

        if (!voucherNumber) continue;

        const dateStr = this.getXml2jsValue(voucher.DATE) || '';
        let voucherDate = '';
        if (dateStr && dateStr.length === 8) {
          voucherDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        }

        // Parse ledger entries (ALLLEDGERENTRIES.LIST)
        const entries = [];
        let entryList = voucher['ALLLEDGERENTRIES.LIST'] || [];
        if (!Array.isArray(entryList)) entryList = [entryList];

        for (const entry of entryList) {
          if (!entry) continue;
          const ledgerName = this.getXml2jsValue(entry.LEDGERNAME) || '';
          const amountStr = this.getXml2jsValue(entry.AMOUNT) || '0';
          const amount = parseFloat(amountStr) || 0;
          const isDeemedPositive = this.getXml2jsValue(entry.ISDEEMEDPOSITIVE) || '';

          if (ledgerName) {
            entries.push({
              ledger_name: ledgerName.trim(),
              amount: Math.abs(amount),
              // In Tally: negative amount = Debit, positive = Credit for ledger entries
              // But ISDEEMEDPOSITIVE overrides: Yes = Debit side, No = Credit side
              is_debit: isDeemedPositive ? isDeemedPositive.toLowerCase() === 'yes' : amount < 0
            });
          }
        }

        vouchers.push({
          voucher_number: voucherNumber,
          voucher_type: voucherType,
          date: voucherDate,
          party_name: this.getXml2jsValue(voucher.PARTYLEDGERNAME) || '',
          total_amount: Math.abs(parseFloat(this.getXml2jsValue(voucher.AMOUNT))) || 0,
          narration: this.getXml2jsValue(voucher.NARRATION) || '',
          reference: this.getXml2jsValue(voucher.REFERENCE) || '',
          entries: entries
        });
      }
    } catch (error) {
      logger.warn('xml2js parsing failed for all vouchers, falling back to regex:', error.message);
      // Regex fallback for vouchers with entries
      const voucherPattern = /<VOUCHER[^>]*>([\s\S]*?)<\/VOUCHER>/gi;
      let voucherMatch;
      while ((voucherMatch = voucherPattern.exec(xmlResponse)) !== null) {
        const content = voucherMatch[1];
        const voucherNumber = this.extractTagValue(content, 'VOUCHERNUMBER');
        if (!voucherNumber) continue;

        const voucherType = this.extractTagValue(content, 'VOUCHERTYPENAME');
        const dateStr = this.extractTagValue(content, 'DATE');
        let voucherDate = '';
        if (dateStr && dateStr.length === 8) {
          voucherDate = `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
        }

        // Parse entries from ALLLEDGERENTRIES.LIST blocks
        const entries = [];
        const entryPattern = /<ALLLEDGERENTRIES\.LIST>([\s\S]*?)<\/ALLLEDGERENTRIES\.LIST>/gi;
        let entryMatch;
        while ((entryMatch = entryPattern.exec(content)) !== null) {
          const entryContent = entryMatch[1];
          const ledgerName = this.extractTagValue(entryContent, 'LEDGERNAME');
          const amountStr = this.extractTagValue(entryContent, 'AMOUNT') || '0';
          const amount = parseFloat(amountStr) || 0;
          const isDeemedPositive = this.extractTagValue(entryContent, 'ISDEEMEDPOSITIVE');

          if (ledgerName) {
            entries.push({
              ledger_name: ledgerName.trim(),
              amount: Math.abs(amount),
              is_debit: isDeemedPositive ? isDeemedPositive.toLowerCase() === 'yes' : amount < 0
            });
          }
        }

        vouchers.push({
          voucher_number: voucherNumber,
          voucher_type: voucherType,
          date: voucherDate,
          party_name: this.extractTagValue(content, 'PARTYLEDGERNAME'),
          total_amount: Math.abs(parseFloat(this.extractTagValue(content, 'AMOUNT'))) || 0,
          narration: this.extractTagValue(content, 'NARRATION'),
          reference: this.extractTagValue(content, 'REFERENCE'),
          entries: entries
        });
      }
    }

    logger.info(`Parsed ${vouchers.length} vouchers (all types) from Tally`);
    return vouchers;
  }

  // ==========================================
  // FULL BOOKS TWO-WAY SYNC METHODS
  // ==========================================

  /**
   * Fetch vouchers from Tally filtered by specific voucher types.
   * Optimization over getAllVouchers() when only subset of types needed.
   */
  async getVouchersByTypes(startDate, endDate, voucherTypes) {
    if (!voucherTypes || voucherTypes.length === 0) {
      return await this.getAllVouchers(startDate, endDate);
    }

    const formattedStartDate = this.formatTallyDate(startDate);
    const formattedEndDate = this.formatTallyDate(endDate);

    // Build TDL filter for selected voucher types
    const typeConditions = voucherTypes.map(t => `$VOUCHERTYPENAME = "${this.escapeXml(t)}"`).join(' OR ');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>FilteredVouchers</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
        <SVFROMDATE>${formattedStartDate}</SVFROMDATE>
        <SVTODATE>${formattedEndDate}</SVTODATE>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="FilteredVouchers">
            <TYPE>Voucher</TYPE>
            <FILTER>VoucherTypeFilter</FILTER>
            <FETCH>DATE, VOUCHERNUMBER, VOUCHERTYPENAME, PARTYLEDGERNAME, AMOUNT, NARRATION, REFERENCE</FETCH>
            <FETCH>ALLLEDGERENTRIES.LIST</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="VoucherTypeFilter">
            ${typeConditions}
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml, 3);
      logger.info(`Tally getVouchersByTypes response length: ${response ? response.length : 0} (types: ${voucherTypes.join(', ')})`);
      return await this.parseAllVouchersResponse(response);
    } catch (error) {
      logger.error('Failed to get vouchers by types:', error);
      throw error;
    }
  }

  /**
   * Ensure a ledger exists in Tally; create it if not found.
   * Generic version of ensurePartyLedger() for any ledger type.
   */
  async ensureLedgerExists(ledgerName, parentGroup) {
    if (!ledgerName) return;

    const checkXml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <VERSION>1</VERSION>
    <TALLYREQUEST>Export</TALLYREQUEST>
    <TYPE>Collection</TYPE>
    <ID>CheckLedger</ID>
  </HEADER>
  <BODY>
    <DESC>
      <STATICVARIABLES>
        <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      </STATICVARIABLES>
      <TDL>
        <TDLMESSAGE>
          <COLLECTION NAME="CheckLedger">
            <TYPE>Ledger</TYPE>
            <FILTER>LedgerNameFilter</FILTER>
            <FETCH>NAME</FETCH>
          </COLLECTION>
          <SYSTEM TYPE="Formulae" NAME="LedgerNameFilter">
            $NAME = "${this.escapeXml(ledgerName)}"
          </SYSTEM>
        </TDLMESSAGE>
      </TDL>
    </DESC>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(checkXml);
      const parsed = await this.parseXmlResponse(response);
      const envelope = parsed.ENVELOPE || parsed;
      let found = false;

      if (envelope.BODY) {
        const body = Array.isArray(envelope.BODY) ? envelope.BODY[0] : envelope.BODY;
        const data = body.DATA || body;
        const collection = Array.isArray(data) ? data[0] : data;
        if (collection.COLLECTION) {
          const coll = Array.isArray(collection.COLLECTION) ? collection.COLLECTION[0] : collection.COLLECTION;
          found = !!(coll.LEDGER);
        } else if (collection.LEDGER) {
          found = true;
        }
      }

      if (!found && parentGroup) {
        await this.createGenericLedger(ledgerName, parentGroup);
      }
    } catch (error) {
      logger.warn(`Could not verify ledger "${ledgerName}", attempting creation:`, error.message);
      if (parentGroup) {
        await this.createGenericLedger(ledgerName, parentGroup);
      }
    }
  }

  /**
   * Create a generic ledger in Tally under the specified parent group.
   */
  async createGenericLedger(ledgerName, parentGroup) {
    const name = this.escapeXml(ledgerName);
    const parent = this.escapeXml(parentGroup);

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${name}" ACTION="Create">
            <NAME>${name}</NAME>
            <PARENT>${parent}</PARENT>
            <AFFECTSSTOCK>No</AFFECTSSTOCK>
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    try {
      const response = await this.sendRequest(xml);
      const result = this.parseVoucherResponse(response);
      if (result.errors > 0) {
        logger.warn(`Could not create ledger "${ledgerName}" under "${parentGroup}": ${result.errorMessage}`);
      } else {
        logger.info(`Created ledger: ${ledgerName} (under ${parentGroup})`);
      }
    } catch (error) {
      logger.warn(`Failed to create ledger "${ledgerName}":`, error.message);
    }
  }

  /**
   * Build Tally Import XML for ANY voucher type.
   * Generic builder — works for Sales, Purchase, Receipt, Payment, Contra, Journal, etc.
   */
  createVoucherXml(voucher) {
    const voucherType = this.escapeXml(voucher.voucher_type_display || 'Sales');
    const voucherNumber = this.escapeXml(voucher.voucher_number || '');
    const voucherDate = this.formatTallyDate(voucher.voucher_date);
    const partyName = voucher.party_ledger_name ? this.escapeXml(voucher.party_ledger_name) : '';
    const narration = this.escapeXml(
      ((voucher.narration || '') + ' [Synced from NexInvo+]').trim()
    );

    // Build ALLLEDGERENTRIES.LIST from entries
    let ledgerEntries = '';
    for (const entry of (voucher.entries || [])) {
      const ledgerName = this.escapeXml(entry.ledger_name);
      const amount = parseFloat(entry.amount) || 0;
      if (amount === 0) continue;

      // In Tally: ISDEEMEDPOSITIVE=Yes means Debit, No means Credit
      // AMOUNT sign: negative = debit side, positive = credit side
      const isDebit = entry.is_debit;
      const isDeemedPositive = isDebit ? 'Yes' : 'No';
      const tallyAmount = isDebit ? (-Math.abs(amount)) : Math.abs(amount);

      ledgerEntries += `
        <ALLLEDGERENTRIES.LIST>
          <LEDGERNAME>${ledgerName}</LEDGERNAME>
          <ISDEEMEDPOSITIVE>${isDeemedPositive}</ISDEEMEDPOSITIVE>
          <AMOUNT>${tallyAmount.toFixed(2)}</AMOUNT>
        </ALLLEDGERENTRIES.LIST>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${voucherType}" ACTION="Create">
            <DATE>${voucherDate}</DATE>
            <VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER>
            ${partyName ? `<PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>` : ''}
            <NARRATION>${narration}</NARRATION>
            <EFFECTIVEDATE>${voucherDate}</EFFECTIVEDATE>
            ${ledgerEntries}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;

    return xml;
  }

  /**
   * Post a single voucher (any type) to Tally.
   * Ensures party and entry ledgers exist before posting.
   */
  async syncVoucher(voucher) {
    try {
      // Ensure party ledger exists if voucher has a party
      if (voucher.party_ledger_name) {
        await this.ensurePartyLedger(
          { name: voucher.party_ledger_name },
          { defaultPartyGroup: voucher.party_group || 'Sundry Debtors' }
        );
      }

      // Ensure all entry ledgers exist in Tally
      for (const entry of (voucher.entries || [])) {
        if (entry.ledger_name && entry.ledger_group) {
          await this.ensureLedgerExists(entry.ledger_name, entry.ledger_group);
        }
      }

      // Build XML and post
      const voucherXml = this.createVoucherXml(voucher);
      const response = await this.sendRequest(voucherXml);
      const result = this.parseVoucherResponse(response);

      if (result.created > 0 || result.altered > 0) {
        logger.info(`Voucher ${voucher.voucher_number} (${voucher.voucher_type_display}) synced to Tally`);
        return { success: true, voucherNumber: voucher.voucher_number };
      } else if (result.errors > 0) {
        throw new Error(`Tally error: ${result.errorMessage || 'Unknown error'}`);
      }

      return { success: true };
    } catch (error) {
      logger.error(`Failed to sync voucher ${voucher.voucher_number}:`, error);
      throw error;
    }
  }
}

module.exports = TallyConnector;