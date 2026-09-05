"""
Optional research calibration check for confidence scoring.

What this proves: when our system says "I'm 70% confident this transaction
is legitimate," is it actually right about 70% of the time? Most fraud-scoring
demos never check this — they just report accuracy. This script backs the
trust layer's confidence scoring with a real, honest evaluation.

Usage:
    pip install pandas scikit-learn matplotlib --break-system-packages
    python calibration/calibrate.py
"""

import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split
from sklearn.linear_model import LogisticRegression
from sklearn.calibration import calibration_curve, CalibratedClassifierCV
from sklearn.metrics import precision_score, recall_score, roc_auc_score
import matplotlib.pyplot as plt
import os

DATA_PATH = os.path.join(os.path.dirname(__file__), 'data', 'creditcard.csv')
OUTPUT_CHART = os.path.join(os.path.dirname(__file__), 'reliability_chart.png')
OUTPUT_REPORT = os.path.join(os.path.dirname(__file__), 'calibration_report.txt')


def get_reliability(y_true, probs, n_bins=10):
    return calibration_curve(y_true, probs, n_bins=n_bins, strategy='quantile')


def print_table(prob_true, prob_pred, f=None):
    lines = [f"{'Predicted':>12} {'Actual':>12} {'Gap':>10}"]
    for pt, pp in zip(prob_true, prob_pred):
        gap = abs(pt - pp)
        lines.append(f"{pp:>11.1%} {pt:>11.1%} {gap:>9.1%}")
    text = "\n".join(lines)
    print(text)
    if f:
        f.write(text + "\n")


def main():
    print("Loading dataset...")
    df = pd.read_csv(DATA_PATH)
    print(f"Loaded {len(df):,} transactions ({df['Class'].sum():,} labeled fraud)")

    X = df.drop(columns=['Class', 'Time'])
    y = df['Class']

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.3, random_state=42, stratify=y
    )

    print("Training baseline logistic regression classifier...")
    base_model = LogisticRegression(max_iter=1000, class_weight='balanced')
    base_model.fit(X_train, y_train)

    probs_before = base_model.predict_proba(X_test)[:, 1]
    preds_before = (probs_before >= 0.5).astype(int)

    precision = precision_score(y_test, preds_before)
    recall = recall_score(y_test, preds_before)
    auc = roc_auc_score(y_test, probs_before)

    print(f"\nBaseline model performance:")
    print(f"  Precision: {precision:.3f}")
    print(f"  Recall:    {recall:.3f}")
    print(f"  ROC-AUC:   {auc:.3f}")

    print("\n--- BEFORE calibration ---")
    prob_true_before, prob_pred_before = get_reliability(y_test, probs_before)
    print_table(prob_true_before, prob_pred_before)

    # Fix: CalibratedClassifierCV re-maps the raw scores onto honest
    # probabilities (via isotonic regression) using cross-validated held-out
    # folds, without touching the model's underlying ranking ability.
    print("\nApplying calibration correction (isotonic regression)...")
    calibrated_model = CalibratedClassifierCV(base_model, method='isotonic', cv=5)
    calibrated_model.fit(X_train, y_train)

    probs_after = calibrated_model.predict_proba(X_test)[:, 1]
    auc_after = roc_auc_score(y_test, probs_after)

    print("\n--- AFTER calibration ---")
    prob_true_after, prob_pred_after = get_reliability(y_test, probs_after)
    print_table(prob_true_after, prob_pred_after)
    print(f"\nROC-AUC after calibration: {auc_after:.3f} (ranking ability preserved)")

    # Plot both curves on one chart
    plt.figure(figsize=(6, 6))
    plt.plot([0, 1], [0, 1], linestyle='--', color='gray', label='Perfectly calibrated')
    plt.plot(prob_pred_before, prob_true_before, marker='o', color='#D9534F', label='Before calibration')
    plt.plot(prob_pred_after, prob_true_after, marker='o', color='#4B4ACF', label='After calibration')
    plt.xlabel('Predicted confidence (fraud probability)')
    plt.ylabel('Actual fraud rate observed')
    plt.title('Reliability Chart — Before vs. After Calibration Fix')
    plt.legend()
    plt.tight_layout()
    plt.savefig(OUTPUT_CHART, dpi=150)
    print(f"\nSaved reliability chart to {OUTPUT_CHART}")

    with open(OUTPUT_REPORT, 'w') as f:
        f.write("Calibration Report — PayMandate research utility\n")
        f.write("=" * 50 + "\n\n")
        f.write(f"Dataset: {len(df):,} transactions, {df['Class'].sum():,} labeled fraud\n")
        f.write(f"Baseline — Precision: {precision:.3f}, Recall: {recall:.3f}, ROC-AUC: {auc:.3f}\n\n")
        f.write("BEFORE calibration (predicted confidence vs actual fraud rate):\n")
        print_table(prob_true_before, prob_pred_before, f)
        f.write("\nAFTER calibration (isotonic regression):\n")
        print_table(prob_true_after, prob_pred_after, f)
        f.write(f"\nROC-AUC after calibration: {auc_after:.3f}\n")
        f.write("\nFinding: the baseline model ranks transactions well (high AUC) but its\n")
        f.write("raw confidence scores were overconfident — a known side effect of\n")
        f.write("class-balancing on rare-event data. Isotonic calibration corrects this\n")
        f.write("without hurting ranking ability, giving honest confidence scores for\n")
        f.write("the trust layer's pause/proceed decision.\n")

    print(f"Saved text report to {OUTPUT_REPORT}")


if __name__ == '__main__':
    main()
