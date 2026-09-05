# Calibration research utility

This optional utility explores calibration of a fraud-classification model on a separately supplied labelled dataset. It is not required to run PayMandate and does not influence authorization, Trust, Risk, Policy, approval, or payment decisions in the application.

## Run it

1. Place a licensed `creditcard.csv` dataset at `calibration/data/creditcard.csv`.
2. Install the isolated research dependencies:

   ```bash
   python3 -m pip install -r calibration/requirements.txt
   ```

3. Run:

   ```bash
   npm run calibrate
   ```

The script writes a local reliability chart and report. Dataset and generated artifacts are excluded from source control.
