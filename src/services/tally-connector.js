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

  extractTagValue(content, tagName) {
    const pattern = new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, "i");
    const match = content.match(pattern);
    return match ? this.decodeXmlEntities(match[1]).trim() : "";
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
}

module.exports = TallyConnector;